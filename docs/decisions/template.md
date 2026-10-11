---
# MADR 4.0 template (https://adr.github.io/madr/). Copy to NNNN-short-title.md, number sequentially.
# Metadata is optional except status and date, which Harbour always fills in.
status: "{proposed | rejected | accepted | deprecated | superseded by ADR-NNNN}"
date: {YYYY-MM-DD when the decision was last updated}
decision-makers: {everyone involved in the decision}
consulted: {subject-matter experts whose opinions were sought; two-way communication}
informed: {people kept up to date on progress; one-way communication}
---

# {Short title, representative of the problem solved and the solution found}

## Context and problem statement

{Describe the context and problem statement in two or three sentences, or as a question. Link the
master prompt section, issue or spec that raised it.}

<!-- This is an optional element. Feel free to remove. -->
## Decision drivers

- {Driver 1, for example a force or facing concern}
- {Driver 2}

## Considered options

- {Title of option 1}
- {Title of option 2}
- {Title of option 3}

## Decision outcome

Chosen option: "{title of option 1}", because {justification, e.g. only option which meets a
k.o. criterion, or resolves a force, or comes out best (see below)}.

<!-- This is an optional element. Feel free to remove. -->
### Consequences

- Good, because {positive consequence, e.g. improvement of one or more desired qualities}
- Bad, because {negative consequence, e.g. compromising one or more desired qualities}

<!-- This is an optional element. Feel free to remove. -->
### Confirmation

{Describe how the implementation of, or compliance with, the ADR is confirmed: a test, a CI gate,
a review checklist item.}

<!-- This is an optional element. Feel free to remove. -->
## Pros and cons of the options

### {Title of option 1}

- Good, because {argument a}
- Neutral, because {argument b}
- Bad, because {argument c}

### {Title of option 2}

- Good, because {argument a}
- Bad, because {argument b}

<!-- This is an optional element. Feel free to remove. -->
## More information

{Evidence, links to related ADRs and specs, when the decision should be revisited, and how to change it.
Harbour convention: to change an accepted decision, add a new ADR that supersedes it, set this file's
status to "superseded by ADR-NNNN", and keep this file in the repository.}
