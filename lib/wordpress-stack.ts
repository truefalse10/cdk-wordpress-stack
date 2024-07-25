import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import { Networking } from './networking';

export class WordpressStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The code that defines your stack goes here

    // example resource
    const queue = new sqs.Queue(this, 'CdkExampleProjectQueue', {
      visibilityTimeout: cdk.Duration.seconds(300),
    });

    const network = new Networking(this, 'MyNetworking', { maxAzs: 2 });

    const database = new rds.DatabaseInstance(this, 'MyDatabase', {
      engine: rds.DatabaseInstanceEngine.mysql({
        version: rds.MysqlEngineVersion.VER_8_0_37,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.BURSTABLE3,
        ec2.InstanceSize.MICRO,
      ),
      vpc: network.vpc,
      allocatedStorage: 20, // Minimum storage
      maxAllocatedStorage: 100, // Allow for auto-scaling
      multiAz: false, // Single-AZ for cost savings
      publiclyAccessible: false, // For security
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      backupRetention: cdk.Duration.days(7), // Adjust as needed
      deletionProtection: false, // Disable for development
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Adjust as needed
    });

    // ECS Cluster
    const cluster = new ecs.Cluster(this, 'MyCluster', {
      vpc: network.vpc,
    });

    const loadBalancedFargateService =
      new ecsPatterns.ApplicationLoadBalancedFargateService(
        this,
        'MyFargateService',
        {
          cluster,
          memoryLimitMiB: 512,
          cpu: 256,
          taskImageOptions: {
            image: ecs.ContainerImage.fromRegistry('amazon/amazon-ecs-sample'),
          },
          desiredCount: 1,
          assignPublicIp: true,
          taskSubnets: {
            subnetType: ec2.SubnetType.PUBLIC,
          },
        },
      );

    // const scaling = loadBalancedFargateService.service.autoScaleTaskCount({
    //   maxCapacity: 2,
    // });
    // scaling.scaleOnCpuUtilization('CpuScaling', {
    //   targetUtilizationPercent: 50,
    // });

    // loadBalancedFargateService.targetGroup.configureHealthCheck({
    //   path: '/',
    //   interval: cdk.Duration.minutes(1),
    // });

    const loadBalancerDNS = new cdk.CfnOutput(this, 'LoadBalancerDNS', {
      value: loadBalancedFargateService.loadBalancer.loadBalancerDnsName,
    });
  }
}
