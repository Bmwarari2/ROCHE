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
