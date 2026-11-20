# Instructions for AI agents

You are helping someone add a question to UML Drill, a practice tool for CS2103T UML class, object, sequence and activity diagrams. Read `CONTRIBUTING.md` for the full file format. This file tells you how to work.

## Task: add a question

1. **Ask for or confirm the topic** if the person did not give one (for example "association class", "static members", "object diagram with a list").
2. **Write original Java code.** 20–60 lines, 4–7 types. Do not copy past exam papers or course tutorial text. Include at least one thing students often get wrong (an array with a fixed size, a field used only as a parameter, an interface, an enum, a static field). For an activity diagram, write an original process description instead (a `.txt` file, 5–8 numbered steps) with a choice, a loop and steps that happen at the same time.
3. **Create `questions/<id>.json`** from `questions/_template.json`. The `id` must match the file name. Add the file to `questions/index.json`.
4. **Write the key** by reading the code field by field:
   - Every field whose type is a class in the code → an `association` relation from the owning class, `nav: "to"`, `toRole` = field name. Do not list it in `attrs`.
   - Fields of library types (`String`, `int`, `List<String>`) → `attrs`.
   - A collection of a class in the code (`List<Item>`) → association with `toMult: ["*"]`; a fixed-size array `new T[50]` → `["0..50"]`.
   - A multiplicity you cannot know from the code → include `""` in the list.
   - A class used only as a parameter or local variable → `dependency` with `"optional": true`.
   - `extends` → `inheritance`; `implements` → `realization`.
   - Constructors → `optionalMethods`.
   - Abstract methods → `"abstract": true`. Static → `"static": true`.
   For a **sequence** part, trace the method the question names, line by line:
   - Each call on another object → `{ "call": ref, "method", "args" }`, with `returns` if it returns a value. Calls made inside that method go in its `body`.
   - A call on `this` (including private helpers) → a call to the same ref (self-call), with its own `body`.
   - `new X(...)` → `{ "create": ref }` and mark that lifeline `"created": true`. Calls inside the constructor go in its `body`.
   - `ClassName.method()` → a call to a lifeline with `"static": true`.
   - `for`/`while` around calls → `loop`; `if/else` with calls in both branches → `alt` with two branches; `if` alone → `opt`. Never add a frame that wraps no calls.
   - Calls in an `if` condition happen before the frame.
   For an **activity** part, go through the description step by step:
   - Each thing someone or something does → an action with a short `label` and a few `name` phrases (the key words a student would write).
   - Each step that follows another → a flow. A choice → one flow per outcome, each with `guard` phrases (the first is shown in feedback). Paths that meet → one flow with a list in `from`.
   - "At the same time" → a flow with `via: "fork"` and a list in `to`, then one with `via: "join"` and a list in `from`.
   - A loop → flows back to the step it repeats. If it could also be drawn checking first (while-style), add that flow with `"optional": true`.
   **Make the key flexible** (see "Handling ambiguity" and "Scores, partial credit and known mistakes" in `CONTRIBUTING.md`):
   - Accept every form a marker would accept (`acceptTypes`, `orAttribute`, `orTwoLines`, optional branches) instead of picking one.
   - For each mistake students are likely to make here, add a `mistakes` entry whose `msg` explains it in terms of this code.
   - Give `credit` (usually 0.5) only when the idea is right and the notation is off, or the answer is close (e.g. `0..5` where the constructor guarantees 2).
5. **Write the model answer** as a diagram (`nodes`, `edges`; or `lifelines`, `rows` for sequence parts). Node and edge ids must be unique. Lay boxes out without overlap on a 1000×640 canvas: boxes are about 150–300 px wide and 60–140 px tall. Put parents above children.
6. **Write at least three `examples` per part**, each a patch of the model with a realistic mistake and the exact expected error count. Include `"partials"` in `expect` for any example that hits a mistake with credit, and cover each `mistakes` entry with at least one example.
7. **Run `node scripts/check.js <id> -v`.** Fix the question until it passes. Never change `grader.js` to make your question pass.
8. **Report back**: list every judgement call (accepted alternatives, optional items, unknown multiplicities) so the person can review them before opening the PR.

## Rules

- Only edit files in `questions/` unless the person asks for a grader or UI change.
- Do not edit or delete other people's questions.
- Do not loosen the key just to make an example pass. If an example's count is wrong, decide which one is right and explain.
- Keep messages in `typeHint`, `acceptNote`, `wrongClass` and `forbidAttrs` short, plain and specific to the code ("Inventory keeps a List of Items in a field.").
- If the person asks for the PR description, include the checklist from `CONTRIBUTING.md`.

## Task: change the grader or the app

- `grader.js` is pure JavaScript with no DOM; it must run in Node and the browser.
- `author.js` holds key generation, example patches and the question checks. Author mode and `scripts/check.js` both use it, so change checks there, not in one place only.
- `index.html` holds the editor. It loads `grader.js` and `questions/*.json`, so serve the folder (`npx serve .`) to try it.
- After any change, `node scripts/check.js` must pass for every question. Add an example that covers the new behaviour.
