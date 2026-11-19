# UML Drill

Practice CS2103T-style UML questions. Read the code, draw the class, object or sequence diagram with a toolbox, and get it graded mistake by mistake, the way the tutorials count errors.

The grader is flexible where the course is: it accepts common alternatives (for example parameter types without names, or composition where an association also fits) and lists them as notes instead of errors.

## Run it

```sh
npx serve .            # or: python3 -m http.server
```

Open the address it prints. Opening `index.html` straight from disk won't work, because the page loads `questions/*.json`.

## Write questions

Press **Author** in the app to create or edit a question: draw the model answer, generate the answer key from it, mark accepted alternatives, save wrong answers as test examples, and download the file. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Check the questions

```sh
node scripts/check.js        # all questions
node scripts/check.js -v     # print every message
```

This checks that each model answer grades with 0 errors and that each example mistake gives the expected count. It runs on every pull request.

## Layout

| Path | What it is |
| --- | --- |
| `index.html` | The editor and quiz UI |
| `grader.js` | The grader (no DOM, runs in Node and the browser) |
| `author.js` | Key generation, example patches and question checks, shared by author mode and `check.js` |
| `questions/` | One JSON file per question, listed in `index.json` |
| `scripts/check.js` | Validates questions |

## Contribute a question

See [CONTRIBUTING.md](CONTRIBUTING.md). If you use an AI agent, point it at [AGENTS.md](AGENTS.md).

## Deploy

Settings → Pages → deploy from the `main` branch, root folder. No build step.
