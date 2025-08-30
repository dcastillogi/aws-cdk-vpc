import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ram from "aws-cdk-lib/aws-ram";
import { ConfigProps } from "../shared/types";

export class NetworkingStack extends cdk.Stack {
    public readonly vpc: ec2.Vpc;
    public readonly webSubnets: ec2.ISubnet[];
    public readonly appSubnets: ec2.ISubnet[];
    public readonly dataSubnets: ec2.ISubnet[];
    public readonly natInstance: ec2.Instance;
    public readonly subnetAllocation: {
        web: string[];
        app: string[];
        data: string[];
    };

    private ipToNumber(ip: string): number {
        return ip.split('.').reduce((acc, octet) => acc * 256 + parseInt(octet), 0);
    }

    private numberToIp(num: number): string {
        return [(num >>> 24) & 255, (num >>> 16) & 255, (num >>> 8) & 255, num & 255].join('.');
    }

    private calculateFixedSubnetAllocation(vpcCidr: string): {
        web: string[];
        app: string[];
        data: string[];
    } {
        // Fixed allocation: /16 VPC with /20 subnets (4,096 IPs each)
        // 6 subnets total: 2 AZs × 3 tiers = 6 × 4,096 = 24,576 IPs used
        // Remaining: 65,536 - 24,576 = 40,960 IPs available for future use
        
        const [vpcNetwork] = vpcCidr.split('/');
        const vpcPrefix = vpcCidr.split('/')[1];
        
        // Validate VPC is /16
        if (vpcPrefix !== '16') {
            throw new Error(`VPC CIDR must be /16, got /${vpcPrefix}`);
        }
        
        const vpcBaseIp = this.ipToNumber(vpcNetwork);
        const subnetSize = 4096; // /20 = 4,096 IPs
        
        // Generate subnet CIDRs sequentially
        const webSubnets: string[] = [];
        const appSubnets: string[] = [];
        const dataSubnets: string[] = [];
        
        // Web subnets: first 2 /20 blocks
        for (let i = 0; i < 2; i++) {
            const subnetBaseIp = vpcBaseIp + (i * subnetSize);
            const subnetNetwork = this.numberToIp(subnetBaseIp);
            webSubnets.push(`${subnetNetwork}/20`);
        }
        
        // App subnets: next 2 /20 blocks
        for (let i = 2; i < 4; i++) {
            const subnetBaseIp = vpcBaseIp + (i * subnetSize);
            const subnetNetwork = this.numberToIp(subnetBaseIp);
            appSubnets.push(`${subnetNetwork}/20`);
        }
        
        // Data subnets: next 2 /20 blocks
        for (let i = 4; i < 6; i++) {
            const subnetBaseIp = vpcBaseIp + (i * subnetSize);
            const subnetNetwork = this.numberToIp(subnetBaseIp);
            dataSubnets.push(`${subnetNetwork}/20`);
        }
        
        return {
            web: webSubnets,
            app: appSubnets,
            data: dataSubnets
        };
    }

    constructor(
        scope: Construct,
        id: string,
        props: cdk.StackProps & {
            config: ConfigProps;
            namePrefix: string;
        }
    ) {
        super(scope, id, props);

        // Validate VPC CIDR is /16
        const vpcPrefix = props.config.cidr.split('/')[1];
        if (vpcPrefix !== '16') {
            throw new Error(`VPC CIDR must be /16, got /${vpcPrefix}. This CDK is designed for /16 VPCs with /20 subnets.`);
        }

        // Calculate fixed subnet allocation
        const allocation = this.calculateFixedSubnetAllocation(props.config.cidr);
        this.subnetAllocation = allocation;

        // Create VPC without subnet configuration
        this.vpc = new ec2.Vpc(this, "VPC", {
            ipAddresses: ec2.IpAddresses.cidr(props.config.cidr),
            maxAzs: 2,
            vpcName: `${props.namePrefix}-vpc`,
            subnetConfiguration: [], // Empty - we'll create subnets manually
        });

        // Enable DNS hostnames
        const cfnVpc = this.vpc.node.defaultChild as ec2.CfnVPC;
        cfnVpc.enableDnsHostnames = true;

        // Create Internet Gateway explicitly since VPC with empty subnets may not create one reliably
        const internetGateway = new ec2.CfnInternetGateway(this, "InternetGateway", {
            tags: [{ key: "Name", value: `${props.namePrefix}-igw` }]
        });

        // Attach Internet Gateway to VPC
        new ec2.CfnVPCGatewayAttachment(this, "IGWAttachment", {
            vpcId: this.vpc.vpcId,
            internetGatewayId: internetGateway.ref
        });

        // Create route tables first
        const webRouteTable = new ec2.CfnRouteTable(this, "WebRouteTable", {
            vpcId: this.vpc.vpcId,
            tags: [{ key: "Name", value: `${props.namePrefix}-web-rtb` }],
        });

        const appRouteTable = new ec2.CfnRouteTable(this, "AppRouteTable", {
            vpcId: this.vpc.vpcId,
            tags: [{ key: "Name", value: `${props.namePrefix}-app-rtb` }],
        });

        const dataRouteTable = new ec2.CfnRouteTable(this, "DataRouteTable", {
            vpcId: this.vpc.vpcId,
            tags: [{ key: "Name", value: `${props.namePrefix}-data-rtb` }],
        });

        // Get availability zones
        const azs = cdk.Stack.of(this).availabilityZones.slice(0, 2);

        // Create web subnets (public) and associate with web route table
        const webSubnetsArray: ec2.CfnSubnet[] = [];
        azs.forEach((az, index) => {
            // Use index-based naming since AZ names are tokens at synthesis time
            const azSuffix = (index + 1).toString(); // 1, 2, 3, etc.
            
            const subnet = new ec2.CfnSubnet(this, `WebSubnet${index}`, {
                vpcId: this.vpc.vpcId,
                cidrBlock: allocation.web[index],
                availabilityZone: az,
                mapPublicIpOnLaunch: true,
                tags: [{ key: "Name", value: `${props.namePrefix}-web-${azSuffix}` }],
            });
            
            // Associate with web route table
            new ec2.CfnSubnetRouteTableAssociation(this, `WebSubnetRTA${index}`, {
                subnetId: subnet.ref,
                routeTableId: webRouteTable.ref,
            });
            
            webSubnetsArray.push(subnet);
        });

        // Create app subnets (private with egress) and associate with app route table
        const appSubnetsArray: ec2.CfnSubnet[] = [];
        azs.forEach((az, index) => {
            const azSuffix = (index + 1).toString(); // 1, 2, 3, etc.
            
            const subnet = new ec2.CfnSubnet(this, `AppSubnet${index}`, {
                vpcId: this.vpc.vpcId,
                cidrBlock: allocation.app[index],
                availabilityZone: az,
                tags: [{ key: "Name", value: `${props.namePrefix}-app-${azSuffix}` }],
            });
            
            // Associate with app route table
            new ec2.CfnSubnetRouteTableAssociation(this, `AppSubnetRTA${index}`, {
                subnetId: subnet.ref,
                routeTableId: appRouteTable.ref,
            });
            
            appSubnetsArray.push(subnet);
        });

        // Create data subnets (private isolated) and associate with data route table
        const dataSubnetsArray: ec2.CfnSubnet[] = [];
        azs.forEach((az, index) => {
            const azSuffix = (index + 1).toString(); // 1, 2, 3, etc.
            
            const subnet = new ec2.CfnSubnet(this, `DataSubnet${index}`, {
                vpcId: this.vpc.vpcId,
                cidrBlock: allocation.data[index],
                availabilityZone: az,
                tags: [{ key: "Name", value: `${props.namePrefix}-data-${azSuffix}` }],
            });
            
            // Associate with data route table
            new ec2.CfnSubnetRouteTableAssociation(this, `DataSubnetRTA${index}`, {
                subnetId: subnet.ref,
                routeTableId: dataRouteTable.ref,
            });
            
            dataSubnetsArray.push(subnet);
        });

        // Convert CfnSubnets to ISubnet interfaces for public properties
        this.webSubnets = webSubnetsArray.map((subnet, index) => 
            ec2.Subnet.fromSubnetAttributes(this, `WebSubnetRef${index}`, {
                subnetId: subnet.ref,
                availabilityZone: azs[index],
                routeTableId: webRouteTable.ref
            })
        );
        this.appSubnets = appSubnetsArray.map((subnet, index) => 
            ec2.Subnet.fromSubnetAttributes(this, `AppSubnetRef${index}`, {
                subnetId: subnet.ref,
                availabilityZone: azs[index],
                routeTableId: appRouteTable.ref
            })
        );
        this.dataSubnets = dataSubnetsArray.map((subnet, index) => 
            ec2.Subnet.fromSubnetAttributes(this, `DataSubnetRef${index}`, {
                subnetId: subnet.ref,
                availabilityZone: azs[index],
                routeTableId: dataRouteTable.ref
            })
        );

        // Add internet gateway route to web route table
        new ec2.CfnRoute(this, "WebInternetRoute", {
            routeTableId: webRouteTable.ref,
            destinationCidrBlock: "0.0.0.0/0",
            gatewayId: internetGateway.ref,
        });

        // Create NAT instance security group
        const natSG = new ec2.SecurityGroup(this, "NatSG", {
            vpc: this.vpc,
            description: "Security group for NAT instance",
            allowAllOutbound: true,
            securityGroupName: `${props.namePrefix}-nat-sg`,
        });
        cdk.Tags.of(natSG).add("Name", `${props.namePrefix}-nat-sg`);

        // Allow inbound HTTP and HTTPS traffic from private subnets
        natSG.addIngressRule(
            ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
            ec2.Port.allTraffic(),
            "Allow all traffic from VPC"
        );

        // Create IAM role for the NAT instance
        const natRole = new iam.Role(this, "NatInstanceRole", {
            assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName(
                    "AmazonSSMManagedInstanceCore"
                ),
            ],
            roleName: `${props.namePrefix}-nat-instance-role`,
        });

        // Create NAT instance in the first public subnet
        this.natInstance = new ec2.Instance(this, "NatInstance", {
            vpc: this.vpc,
            instanceType: ec2.InstanceType.of(
                ec2.InstanceClass.T4G,
                ec2.InstanceSize.NANO
            ),
            machineImage: ec2.MachineImage.latestAmazonLinux2023({
                cpuType: ec2.AmazonLinuxCpuType.ARM_64,
            }),
            securityGroup: natSG,
            vpcSubnets: {
                subnets: [this.webSubnets[0]],
            },
            role: natRole,
            instanceName: `${props.namePrefix}-nat-instance`,
            sourceDestCheck: false,
        });

        // Add user data to configure NAT functionality
        this.natInstance.addUserData(
            // Update packages
            "sudo dnf update -y",
            "sudo dnf install -y firewalld",

            // Enable IP forwarding
            'sudo sysctl -w net.ipv4.ip_forward=1',
            "echo 'net.ipv4.ip_forward = 1' | sudo tee -a /etc/sysctl.conf",

            // Start and enable firewalld
            'sudo systemctl start firewalld',
            'sudo systemctl enable firewalld',

            // Configure firewalld for NAT
            'sudo firewall-cmd --add-masquerade --permanent',

            // Add public interface to firewalld and allow forwarding
            'sudo firewall-cmd --permanent --zone=public --add-interface=ens5',
            'sudo firewall-cmd --permanent --direct --add-rule ipv4 filter FORWARD 0 -j ACCEPT',
            
            // Reload firewalld to apply changes
            'sudo firewall-cmd --reload'
        );

        // Add NAT instance route to app route table
        new ec2.CfnRoute(this, "AppNatRoute", {
            routeTableId: appRouteTable.ref,
            destinationCidrBlock: "0.0.0.0/0",
            instanceId: this.natInstance.instanceId,
        });

        // Create S3 Gateway Endpoint
        const s3Endpoint = new ec2.CfnVPCEndpoint(this, "S3Endpoint", {
            vpcId: this.vpc.vpcId,
            serviceName: `com.amazonaws.${this.region}.s3`,
            vpcEndpointType: "Gateway",
            routeTableIds: [appRouteTable.ref],
        });

        // Add Name tag to S3 endpoint
        cdk.Tags.of(s3Endpoint).add("Name", `${props.namePrefix}-vpce-s3`);

        // Create DynamoDB Gateway Endpoint
        const dynamoDbEndpoint = new ec2.CfnVPCEndpoint(this, "DynamoDbEndpoint", {
            vpcId: this.vpc.vpcId,
            serviceName: `com.amazonaws.${this.region}.dynamodb`,
            vpcEndpointType: "Gateway",
            routeTableIds: [appRouteTable.ref],
        });

        // Add Name tag to DynamoDB endpoint
        cdk.Tags.of(dynamoDbEndpoint).add("Name", `${props.namePrefix}-vpce-dynamodb`);

        // Share subnets via RAM if accounts are specified
        if (props.config.accounts && props.config.accounts.length > 0) {
            // Create resource share for all subnets
            const subnetArns = [
                ...webSubnetsArray.map(subnet => 
                    `arn:aws:ec2:${this.region}:${this.account}:subnet/${subnet.ref}`
                ),
                ...appSubnetsArray.map(subnet => 
                    `arn:aws:ec2:${this.region}:${this.account}:subnet/${subnet.ref}`
                ),
                ...dataSubnetsArray.map(subnet => 
                    `arn:aws:ec2:${this.region}:${this.account}:subnet/${subnet.ref}`
                )
            ];

            const resourceShare = new ram.CfnResourceShare(this, "SubnetResourceShare", {
                name: `${props.namePrefix}-subnet-share`,
                resourceArns: subnetArns,
                principals: props.config.accounts,
                allowExternalPrincipals: false,
                tags: [
                    { key: "Name", value: `${props.namePrefix}-subnet-share` },
                    { key: "Purpose", value: "Cross-account subnet sharing" }
                ]
            });
        }
    }
}
