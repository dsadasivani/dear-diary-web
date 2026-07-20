# Staging continuous delivery

The staging deployment workflow is intentionally manual-only during its pilot. Pushing the workflow cannot deploy AWS resources by itself.

## Deployment order and gates

1. Require a successful `CI` push run for the exact commit.
2. Authenticate to AWS with a short-lived GitHub OIDC token.
3. Reuse the commit-tagged ECR image when it already exists; otherwise build and push it once.
4. Wait for ECR scanning and reject Critical or High findings.
5. Render the scanned image digest into the repository-managed ECS task definition.
6. Deploy ECS and wait for service stability.
7. Verify the active digest, public health response, and rollback alarm.
8. Optionally start an Amplify release and verify every referenced JavaScript and CSS asset has the correct MIME type.

The frontend option must remain off until Amplify auto-build is disabled for the staging branch. This avoids two releases for the same commit.

## One-time AWS setup

The AWS account must have an IAM OpenID Connect provider with:

- Provider URL: `https://token.actions.githubusercontent.com`
- Audience: `sts.amazonaws.com`

Create it under **IAM > Identity providers** if it does not exist. Do not create an IAM access key for GitHub.

From the repository root, create the staging role and attach its inline policy:

```powershell
$roleName = 'DearDiaryGitHubStagingDeployRole'

aws iam create-role `
  --role-name $roleName `
  --assume-role-policy-document file://ops/aws/iam/github-actions-staging-trust-policy.json

aws iam put-role-policy `
  --role-name $roleName `
  --policy-name DearDiaryStagingDeploy `
  --policy-document file://ops/aws/iam/github-actions-staging-permissions.json

aws iam get-role `
  --role-name $roleName `
  --query 'Role.Arn' `
  --output text
```

The trust policy accepts tokens only from the `staging` GitHub environment in `dsadasivani/dear-diary-web`. The permissions policy can update only the existing staging ECS service and Amplify branch, pass only the two existing ECS roles, and push only to the sync API repository.

## One-time GitHub setup

Under **Repository settings > Environments**:

1. Create an environment named `staging`.
2. Restrict its deployment branches to `feature/aws-deployment` during the pilot.
3. Add an environment variable named `AWS_DEPLOY_ROLE_ARN` containing the role ARN printed above.

This is a variable, not a secret: an IAM role ARN contains no credentials.

## Pilot sequence

1. Commit and push the repository changes.
2. Wait for CI to succeed on that commit.
3. While this workflow exists only on the feature branch, trigger the backend pilot with a commit whose message contains `[deploy-staging]`. The workflow waits for CI on that exact commit before deploying. Ordinary commits do not deploy.
4. Verify backend synchronization from web and mobile.
5. Disable Amplify auto-build for `feature/aws-deployment`.
6. Trigger the full pilot with a commit whose message contains `[deploy-staging-web]`.
7. Verify login and two-way synchronization.

After the workflow reaches the default branch, GitHub also exposes its manual `workflow_dispatch` control in the Actions tab. After both pilot runs succeed, replace the commit-message gate so a successful staging-branch CI run starts the deployment automatically.
