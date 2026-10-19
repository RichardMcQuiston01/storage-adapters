# Security Policy

## Reporting a vulnerability

Please report security problems **privately**. Do not open a public issue or pull request for them.

Use GitHub's private vulnerability reporting:

1. Go to the [Security tab](https://github.com/RichardMcQuiston01/storage-adapters/security) of this repository.
2. Choose **Report a vulnerability**.
3. Describe the problem: which entry point and version, what you did, what happened, and what you expected. A short reproduction helps most.

Only the maintainer can see the report. Please give them time to fix the problem before you share it elsewhere.

## What is covered

The `@richardmcquiston01/storage-adapters` package and its entry points. Problems in a driver or SDK that an adapter uses (`pg`, `mysql2`, the AWS SDK, the Firebase SDKs and the others) are best reported to that project.

Some things are your responsibility, not the adapters', and are not vulnerabilities in this package: the access rules on your own database, bucket or Firebase project (Firestore and Realtime Database security rules, Supabase row-level security policies, S3 permissions), and the permissions on the files the file adapters write.

## Supported versions

Security fixes go into the latest minor of the current major version. After a new major version is released, the last minor of the previous major also gets security fixes for six months. Details are in [Versioning, support and deprecation](docs/versioning-policy.md#support). Before 1.0.0, only the latest release is supported.

## What to expect

This project is maintained by one person on a best-effort basis, so there is no guaranteed response time. A confirmed problem is fixed in a patch release, and the [changelog](CHANGELOG.md) says what was fixed.
