import { Construct } from "constructs";
import { TerraformOutput } from "cdktf";
import { RdsCluster } from "@cdktf/provider-aws/lib/rds-cluster";
import { RdsClusterInstance } from "@cdktf/provider-aws/lib/rds-cluster-instance";
import { DbInstance } from "@cdktf/provider-aws/lib/db-instance";
import { DbSubnetGroup } from "@cdktf/provider-aws/lib/db-subnet-group";
import { DataAwsCallerIdentity } from "@cdktf/provider-aws/lib/data-aws-caller-identity";
import { StaticResource } from "@cdktf/provider-time/lib/static-resource";
import { SecurityGroup } from "@cdktf/provider-aws/lib/security-group";
import { VpcModule } from "@scalereal/terraform-aws-vpc";

export interface RdsModuleConfig {
  username: string;
  password: string;
  maintenanceWindow: string;
  backupWindow: string;
  backupRetentionPeriod: number;
  dbName: string;
  engine: string;
  engineVersion: string;
  instanceClass?: string; // Optional for Aurora, required for standard RDS
  isAurora: boolean;
  numberOfInstances?: number; // Optional, For Aurora, number of instances in cluster.
  allocatedStorage?: number; // Optional for Aurora, required for standard RDS
  serviceName: string;
  env: string;
  tags?: { [key: string]: string };
  vpc: VpcModule;
}
export class RdsModule extends Construct {
  // Outputs
  public readonly rdsEndpoint: string;
  public readonly username: string;
  public readonly password: string;
  public readonly securityGroup: SecurityGroup;

  constructor(scope: Construct, id: string, config: RdsModuleConfig) {
    super(scope, id);
    const {
      username,
      password,
      maintenanceWindow,
      backupWindow,
      backupRetentionPeriod,
      dbName,
      engine,
      engineVersion,
      instanceClass,
      isAurora,
      numberOfInstances,
      allocatedStorage,
      serviceName,
      env,
      tags = {},
      vpc,
    } = config;
    // Get caller identity and time
    const caller = new DataAwsCallerIdentity(this, "caller");
    const timeStatic = new StaticResource(this, "timestamp");
    // Define default tags
    const defaultTags = {
      Name: `${serviceName}-${env}`,
      Service: serviceName,
      ENV: env,
      Provisioner: "CDKTF",
      "Provisioned By": caller.userId,
      "Provisioned Date": timeStatic.id,
    };

    // Create a Security Group based on engine type
    this.securityGroup = new SecurityGroup(this, "rds-sg", {
      name: `${serviceName}-${env}-rds-sg`,
      description: `Security group for ${serviceName} RDS`,
      vpcId: vpc.vpc_id,
      ingress: [
        {
          protocol: "tcp",
          fromPort: engine.includes("postgres") ? 5432 : 3306,
          toPort: engine.includes("postgres") ? 5432 : 3306,
          cidrBlocks: [vpc.vpc_cidr],
          ipv6CidrBlocks: [vpc.vpc_ipv6_cidr],
          description: `Allow ${
            engine.includes("postgres") ? "PostgreSQL" : "MySQL"
          } traffic`,
        },
      ],
      egress: [
        {
          protocol: "-1",
          fromPort: 0,
          toPort: 0,
          cidrBlocks: ["0.0.0.0/0"],
          ipv6CidrBlocks: ["::/0"],
        },
      ],
      tags: { ...defaultTags, ...tags },
    });

    // Create a DB Subnet Group
    const dbSubnetGroup = new DbSubnetGroup(this, "db-subnet-group", {
      name: `${serviceName}-${env}-db-subnet-group`,
      subnetIds: vpc.database_subnet_ids!,
      tags: { ...defaultTags, ...tags },
    });

    if (isAurora) {
      // Create an Aurora RDS Cluster
      const auroraCluster = new RdsCluster(this, "rds-cluster", {
        clusterIdentifier: `${serviceName}-${env}-aurora-cluster`,
        engine: engine,
        engineVersion: engineVersion,
        databaseName: dbName,
        masterUsername: username,
        masterPassword: password,
        backupRetentionPeriod: backupRetentionPeriod,
        preferredBackupWindow: backupWindow,
        preferredMaintenanceWindow: maintenanceWindow,
        skipFinalSnapshot: true,
        storageType: "gp3",
        storageEncrypted: true,
        dbSubnetGroupName: dbSubnetGroup.name,
        vpcSecurityGroupIds: [this.securityGroup.id],
        tags: { ...defaultTags, ...tags },
      });
      // Create Aurora instances
      const numInstances = numberOfInstances || 1;
      for (let i = 0; i < numInstances; i++) {
        new RdsClusterInstance(this, `rds-cluster-instance-${i}`, {
          clusterIdentifier: auroraCluster.id,
          engine: auroraCluster.engine,
          instanceClass: instanceClass || "db.t4g.medium",
          dbSubnetGroupName: dbSubnetGroup.name,
          tags: { ...defaultTags, ...tags },
        });
      }
      // Output the Aurora cluster endpoint
      new TerraformOutput(this, "aurora_cluster_endpoint", {
        value: auroraCluster.endpoint,
      });
      this.rdsEndpoint = auroraCluster.endpoint;
    } else {
      // Create a standard RDS Instance
      const rdsInstance = new DbInstance(this, "rds-instance", {
        identifier: `${serviceName}-${env}-rds-instance`,
        engine: engine,
        engineVersion: engineVersion,
        instanceClass: instanceClass!,
        allocatedStorage: allocatedStorage!,
        dbName: dbName,
        username: username,
        password: password,
        backupRetentionPeriod: backupRetentionPeriod,
        backupWindow: backupWindow,
        maintenanceWindow: maintenanceWindow,
        skipFinalSnapshot: true,
        dbSubnetGroupName: dbSubnetGroup.name,
        vpcSecurityGroupIds: [this.securityGroup.id],
        storageEncrypted: true,
        storageType: "gp3",
        multiAz: numberOfInstances !== undefined && numberOfInstances > 1,
        tags: { ...defaultTags, ...tags },
      });
      // Output the RDS instance endpoint
      new TerraformOutput(this, "rds_instance_endpoint", {
        value: rdsInstance.endpoint,
      });
      this.rdsEndpoint = rdsInstance.endpoint;
    }
    this.username = username;
    this.password = password;
  }
}
