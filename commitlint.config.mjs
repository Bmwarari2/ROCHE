// Conventional Commits with Harbour scopes: the 14 bounded contexts plus the apps, packages, infra and docs
// (master prompt section 7).
const contexts = [
  "platform",
  "people",
  "care",
  "medicines",
  "safety",
  "quality",
  "workforce",
  "scheduling",
  "operations",
  "finance",
  "comms",
  "insights",
  "integrations",
  "ai",
];

export default {
  extends: ["@commitlint/config-conventional"],
  // Dependabot writes its own subject and scope ("chore(deps-dev): Bump ..."); its pull requests are
  // reviewed on the diff, so its commits are not held to the Harbour scopes. Merge commits that
  // bring a base or a stacked branch in are not Conventional Commits whatever their title says;
  // the default ignores cover only Git's own wording ("Merge branch ...").
  ignores: [
    (message) => /^Signed-off-by: dependabot\[bot\]/m.test(message),
    (message) => /^Merge /.test(message),
  ],
  rules: {
    "scope-enum": [
      2,
      "always",
      [
        ...contexts,
        "web",
        "mobile",
        "api",
        "infra",
        "docs",
        "ui",
        "domain",
        "db",
        "contracts",
        "sync",
        "i18n",
        "config",
        "ci",
        "deps",
        "repo",
      ],
    ],
    "subject-case": [2, "never", ["upper-case", "pascal-case", "start-case"]],
    "body-max-line-length": [0],
    "footer-max-line-length": [0],
  },
};
