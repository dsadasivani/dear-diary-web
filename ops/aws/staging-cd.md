# Staging continuous delivery

The repository has one shared staging environment. CI runs for pull requests targeting `main` and
for every update to those pull requests. Direct feature-branch and post-merge `main` pushes do not
start a duplicate CI run. Deployment behavior is intentionally different by source:

- A successful `main` push starts staging CD automatically.
- A `feature/**` commit is deployed only through **Actions > Deploy staging > Run workflow**.
- Manual deployments can use `auto`, `frontend`, `backend`, or `both` scope.
- Amplify auto-build is disabled. GitHub Actions is the only web deployment owner.

The shared environment may intentionally contain components from different source branches. For
example, deploying a backend-only feature and then a frontend-only `main` change leaves the feature
backend alongside the `main` frontend.

## Change detection

For a `main` push, the workflow compares the pushed commit range. For a manual feature deployment,
`auto` compares the selected commit with its merge-base on `main`.

Backend deployment paths:

- `backend/sync-api/**`
- `ops/aws/lambda/sync-api.staging.yml`

Frontend deployment paths:

- `src/**`
- `public/**`
- `index.html`
- `package.json` and `package-lock.json`
- `vite.config.ts` and `tsconfig.json`
- `.env.staging`
- `amplify.yml` and `customHttp.yml`
- `scripts/validate-production-config.mjs`

Changes outside these paths do not deploy application components. Use an explicit manual scope when
an indirect dependency is not represented by this list.

## Deployment gates

Both component jobs require successful pull-request `CI`. Manual feature deployments require the
selected commit to be the head of an open PR targeting `main`. Automatic `main` deployments require
the pushed commit to belong to a merged PR targeting `main`; direct pushes are blocked. Both paths
then verify successful CI for that PR's exact feature-head commit before deploying.

### Backend

1. Authenticate to AWS with a short-lived GitHub OIDC token.
2. Reuse the commit-tagged Lambda image when present; otherwise build and push its ARM64 target.
3. Wait for ECR scanning and reject Critical or High findings.
4. Read the staging secrets from Parameter Store without writing them to logs.
5. Deploy the immutable digest and configuration to Lambda.
6. Verify the active digest, health response, JWT boundary, and staging CORS response.

### Frontend

1. Confirm that Amplify auto-build is disabled.
2. Move the machine-managed Git branch `staging` to the selected source commit.
3. Start an Amplify `RELEASE` job for that branch.
4. Verify every referenced JavaScript and CSS asset has the expected MIME type.

The dedicated `staging` Git branch is necessary because an Amplify repository branch builds the
latest commit from its mapped Git branch. Developers must not commit directly to this branch.

## One-time AWS setup

The AWS account must have an IAM OpenID Connect provider with:

- Provider URL: `https://token.actions.githubusercontent.com`
- Audience: `sts.amazonaws.com`

Create the GitHub deployment role and attach the repository-managed inline policy:

```powershell
$roleName = 'DearDiaryGitHubStagingDeployRole'

aws iam create-role `
  --role-name $roleName `
  --assume-role-policy-document file://ops/aws/iam/github-actions-staging-trust-policy.json

aws iam put-role-policy `
  --role-name $roleName `
  --policy-name DearDiaryStagingDeploy `
  --policy-document file://ops/aws/iam/github-actions-staging-permissions.json
```

The trust policy accepts tokens only from the `staging` GitHub environment. The permissions policy
can update only the staging Lambda, read staging parameters, push to the sync API ECR repository,
and start or inspect jobs for the Amplify `staging` branch.

## One-time staging branch setup

Run these steps after this workflow is available on `main`:

1. Create the machine-managed Git branch from `main`:

   ```powershell
   git fetch origin main
   git push origin origin/main:refs/heads/staging
   ```

2. In Amplify, connect the repository branch named `staging` to app `d33b4rjnv35mrn`.
3. Disable auto-build for both `staging` and the old `feature/aws-deployment` Amplify branch.
4. Confirm the staging URL is `https://staging.d33b4rjnv35mrn.amplifyapp.com`.
5. Apply the updated IAM inline policy shown above.
6. Apply the repository-managed S3 CORS configuration:

   ```powershell
   aws s3api put-bucket-cors `
     --bucket dear-diary-sync-staging-908027418886 `
     --cors-configuration file://ops/aws/s3/cors.staging.json `
     --region ap-south-1
   ```

7. Apply the repository-managed ECR lifecycle policy, which retains the active image and two
   additional rollback candidates as the latest three images:

   ```powershell
   aws ecr put-lifecycle-policy `
     --repository-name dear-diary-sync-api `
     --lifecycle-policy-text file://ops/aws/ecr/lifecycle-policy.staging.json `
     --region ap-south-1
   ```

8. Deploy the Lambda Function URL stack. Fetch secret parameters into the current PowerShell
   process so they are not committed or printed:

   ```powershell
   $region = 'ap-south-1'
   $imageUri = '<immutable ECR image URI produced by the Lambda image build>'
   $dbUrl = aws ssm get-parameter --region $region --name /dear-diary/staging/sync-db-url --with-decryption --query 'Parameter.Value' --output text
   $dbUsername = aws ssm get-parameter --region $region --name /dear-diary/staging/sync-db-username --with-decryption --query 'Parameter.Value' --output text
   $dbPassword = aws ssm get-parameter --region $region --name /dear-diary/staging/sync-db-password --with-decryption --query 'Parameter.Value' --output text

   aws cloudformation deploy `
     --region $region `
     --stack-name dear-diary-sync-lambda-staging `
     --template-file ops/aws/lambda/sync-api.staging.yml `
     --capabilities CAPABILITY_NAMED_IAM `
     --parameter-overrides "ImageUri=$imageUri" "DbUrl=$dbUrl" "DbUsername=$dbUsername" "DbPassword=$dbPassword"
   ```

9. Deploy the weekday Lambda warm-up schedules:

   ```powershell
   aws cloudformation deploy `
     --region $region `
     --stack-name dear-diary-staging-lambda-warmup `
     --template-file ops/aws/scheduler/staging-lambda-warmup.yml `
     --capabilities CAPABILITY_NAMED_IAM
   ```

Do not enable branch protection that prevents GitHub Actions from force-updating the machine-managed
`staging` branch.

## Staging compute and rollback

The backend runs as a 2 GiB ARM64 Lambda container behind a Function URL. The account has a total
Lambda concurrency quota of 10, and each instance uses a two-connection database pool. Lambda Web
Adapter exposes the unchanged Spring Boot server on port 8080. CloudWatch retains logs for 14 days;
the Lambda-specific runtime disables duplicate OTLP export.

The frontend allows 60 seconds for API requests so a measured 20–24 second Spring Boot cold start
can complete. EventBridge Scheduler invokes `/actuator/health` at 08:55 IST on weekdays and every ten
minutes from 09:00 through 20:50 IST. The first invocation absorbs the expected morning cold start;
the remaining invocations reduce, but cannot eliminate, later cold starts caused by AWS recycling an
execution environment. Scheduled asynchronous events have a 60-second maximum age and zero retries,
so an invocation racing with vacation-mode shutdown cannot remain queued for a later restart.

The former ECS Express service, managed ALB, target groups, public IPv4 addresses, security group,
rollback alarm, and ECS scheduler stack were retired after the Lambda cutover passed health,
authentication, CORS, and published-asset verification. The disabled ECS scheduler template and task
definition remain only as reconstruction references; they are not deployed and incur no charge. The
active Lambda warmer is defined separately in `ops/aws/scheduler/staging-lambda-warmup.yml`.

Lambda rollback uses the previous immutable ECR digest with `aws lambda update-function-code`. A
return to ECS requires creating a new Express Gateway service rather than waking an existing service.

## Vacation mode

Use **Actions > Staging vacation mode > Run workflow** and select one of:

- `off`: disable both warm-up schedules, change the Function URL to AWS IAM authentication, and set
  reserved concurrency to zero. Public API requests return `403` and Lambda cannot start containers.
- `on`: remove the concurrency lock, restore the public Function URL, enable both warm-up schedules,
  and wait for health to return.
- `status`: report the current state without changing it.

Vacation mode does not delete data or images. Amplify continues serving the static web application,
and S3/ECR retain stored objects, but these services do not have an always-running compute charge.
Backend deployments are intentionally blocked while vacation mode is off so a deployment cannot
silently re-enable or partially verify the API.

The vacation workflow treats the API controls and both warm-up schedules as a single state. A mix of
enabled and disabled settings is reported as `INCONSISTENT` instead of silently claiming that staging
is on or off.

## One-time GitHub setup

Under **Repository settings > Environments > staging**:

1. Allow deployments from `main` and `feature/**`.
2. Keep `AWS_DEPLOY_ROLE_ARN` set to the staging deployment role ARN.

Under **Repository settings > Actions > General > Workflow permissions**:

1. Enable **Read and write permissions** so the web job can update the `staging` source branch.

Protect `main` under **Repository settings > Rules > Rulesets** before enabling this flow:

1. Require a pull request before merging.
2. Require the `CI passed` status check and require branches to be up to date before merging.
3. Block force pushes and branch deletion.
4. Disable bypass for direct pushes, including administrator bypass.

The deployment workflow independently rejects deployable `main` commits that are not associated
with a merged PR, but branch protection remains the primary control that prevents untested commits
from reaching `main`.

## Operation

### Feature deployment

1. Push the feature commit and open a PR targeting `main`.
2. Wait for the PR CI run to pass for the latest commit.
3. Open **Actions > Deploy staging > Run workflow**.
4. Select the feature branch and deployment scope.
5. Run the workflow and review its deployment summary.

### Main deployment

Merge an approved, up-to-date PR to `main`. The deployment workflow starts automatically, verifies
the merged PR and its successful feature-head CI, and deploys only the components detected in that
push. A direct push to `main` fails the deployment gate.
