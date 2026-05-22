# Changesets

This directory tracks pending package version changes. Each notable change should add a changeset describing the version bump (patch/minor/major) and a short summary that will land in the package's CHANGELOG.

To add a changeset:

```bash
npm run changeset
```

To version and tag packages from accumulated changesets:

```bash
npm run version-packages
```

To publish to npm:

```bash
npm run release
```
