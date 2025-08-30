# AWS CDK VPC Infrastructure

AWS CDK project that creates a 3-tier VPC infrastructure with NAT instance for cost optimization and cross-account subnet sharing via AWS Resource Access Manager (RAM).

## Architecture

### 3-Tier Subnet Design
- **Web Tier**: Public subnets with Internet Gateway access
- **App Tier**: Private subnets with NAT instance for egress
- **Data Tier**: Isolated private subnets (no internet access)

### Fixed CIDR Allocation
- **VPC**: Always `/16` (65,536 IPs)
- **Subnets**: Always `/20` (4,096 IPs each)
- **Layout**: 6 subnets across 2 AZs (3 tiers × 2 AZs)
- **Usage**: 24,576 IPs used, 40,960 available for expansion

### Cost Optimization
- **NAT Instance**: `t4g.nano` ARM instance (~90% cheaper than NAT Gateway)
- **VPC Endpoints**: S3 and DynamoDB for free data transfer

### Cross-Account Sharing
- **RAM**: Shares all subnets with specified AWS accounts
- **Organization Support**: Works with AWS Organizations

> **⚠️ Important**: Enable RAM organization sharing in your AWS Organization management account

## Configuration

```json
{
    "env": "prod",
    "project": "network",
    "region": "us-east-1",
    "cidr": "10.10.0.0/16",
    "accounts": ["123456789012"],
    "awsApplicationTag": "arn:aws:resource-groups:us-east-1:123456789012:group/prod-network/xxxxxxxxxxxxxxxx"
}
```

**Requirements:**
- VPC CIDR must be `/16` (65,536 IPs)
- Subnet sizes are fixed at `/20` (4,096 IPs each)

## Deployment

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment:**
   Edit `config/config.json` with your values

3. **Enable RAM Organization Sharing:**
   Go to AWS RAM console → Settings → Enable sharing with organizations

4. **Deploy:**
   ```bash
   npx cdk bootstrap  # First time only
   npm run build
   npx cdk deploy
   ```

## CIDR Allocation

For a `10.10.0.0/16` VPC with fixed `/20` subnets:

| Tier | AZ-1 | AZ-2 | Subnet Size | Usage |
|------|------|------|-------------|-------|
| Web | `10.10.0.0/20` | `10.10.16.0/20` | 4,096 IPs | Public-facing |
| App | `10.10.32.0/20` | `10.10.48.0/20` | 4,096 IPs | Private compute |
| Data | `10.10.64.0/20` | `10.10.80.0/20` | 4,096 IPs | Isolated storage |

**Used**: 24,576 IPs (6 × 4,096)  
**Available**: 40,960 IPs remaining for future expansion

## Resource Sharing (RAM)

### What Gets Shared
- All Web tier subnets
- All Application tier subnets  
- All Data tier subnets