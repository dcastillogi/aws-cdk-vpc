export interface ConfigProps {
    project: string;
    cidr: string; // Must be /16 CIDR
    region: string;
    env: string;
    awsApplicationTag?: string;
    accounts?: string[]; // AWS account IDs to share subnets with via RAM
}
