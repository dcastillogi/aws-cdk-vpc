#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { ConfigProps } from "../shared/types";
import { NetworkingStack } from "../lib/networking-stack";

const app = new cdk.App();

const config = require("../config/config.json") as ConfigProps;

const projectName = config.project;
const envName = config.env;
const namePrefix = `${envName}-${projectName}`;

new NetworkingStack(
    app,
    `${namePrefix}-stack`,
    {
        config,
        namePrefix,
        env: {
            region: config.region,
        },
    }
);

// Tag all resources in the app
if (config.awsApplicationTag) {
    cdk.Tags.of(app).add("awsApplication", config.awsApplicationTag);
}
