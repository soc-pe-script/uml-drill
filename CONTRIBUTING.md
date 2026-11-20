# Contributing questions

Each question is one JSON file in `questions/`. You don't need to touch any code.

## Quick start (in the app)

1. Open the app and press **Author**.
2. Press **New question**, or **Import file…** to edit an existing question file.
3. Fill in the title, code and prompt under **Question** and **Part**.
4. Draw the correct diagram on the canvas and press **Save canvas as model**.
5. Press **Generate from model answer**. Every box, member and line becomes required, except constructors and dependencies.
6. In **Answer key**, mark what else is accepted: optional items, other line types, blank multiplicities, alternative types.
7. Draw at least three common wrong answers and press **Save canvas as example** for each.
8. When **Checks** shows all passing, press **Download**. Put the file in `questions/`, add its name to `questions/index.json`, run `node scripts/check.js`, and open a pull request.

Edits are kept in your browser until you download them. **Discard my changes** restores a question from the repo.

## Quick start (by hand)

1. Fork the repo and clone your fork.
2. Copy `questions/_template.json` to `questions/<your-id>.json`. Use lowercase letters, digits and dashes for the id, and make the file name match it.
3. Add the file name to `questions/index.json`.
4. Fill in the code, prompt, answer key and model answer (details below).
5. Run `node scripts/check.js <your-id>` until it passes.
6. Open the app locally (`npx serve .`), try your question, and draw at least one wrong answer to see the feedback.
7. Open a pull request.

Node 18 or newer is the only requirement. There are no dependencies to install.

## Ground rules

- **Write original questions.** Don't copy past exam papers or tutorial text word for word. Change the domain, names and structure. Put where the idea came from in `source`.
- **One question, one idea.** Two or three parts (class diagram, object diagram) on the same code is ideal.
- **Keep code short.** Under about 60 lines in total, like the exam.
- **Every rule must be defensible.** If markers would accept two forms, accept both (see "Handling ambiguity").

## File format

```jsonc
{
  "id": "library-loans",              // must match the file name
  "title": "Library loans",
  "source": "Original. Idea from the Week 4 association class topic.",
  "author": "your-github-name",
  "tags": ["class-diagram", "association-class"],
  "code": [{ "file": "Book.java", "text": "public class Book { ... }" }],
  "parts": [ /* one entry per part, see below */ ]
}
```

### A part

```jsonc
{
  "id": "a",                          // shown as Q3 (a)
  "mode": "class",                    // "class", "object", "sequence" or "activity"
  "prompt": "Draw a class diagram ...",
  "canvas": { "width": 1000, "height": 640 },
  "starter": { "nodes": [...], "edges": [] },   // the given layout; empty for "draw from scratch"
  "key": { ... },                     // what the grader checks
  "model": { "nodes": [...], "edges": [...] }, // one correct diagram, shown as the model answer
  "examples": [ ... ]                 // wrong answers with the expected error count (tests)
}
```

**Tip:** don't write `starter` or `model` by hand. Draw it in the app and use **Author → Save canvas as model / starter**, or **Diagram JSON** to copy one diagram.

### Key for a class diagram

```jsonc
"key": {
  "classes": {
    "Inventory": {
      "stereo": "",                   // "", "interface", "abstract" or "enumeration"
      "attrs": [{ "name": "count", "vis": "-", "type": ["int"], "static": true }],
      "methods": [
        { "name": "getItemCount", "vis": "+", "params": [], "ret": "int" },
        { "name": "add", "vis": "+", "params": [{ "name": "s", "type": "Item" }] }
      ],
      "optionalMethods": [ /* e.g. constructors: checked if drawn, fine if left out */ ]
    },
    "Rating": { "stereo": "enumeration", "values": ["GOOD", "OK", "POOR"] }
  },
  "relations": [
    { "type": "inheritance", "from": "StockItem", "to": "Item" },
    {
      "type": "association", "from": "Inventory", "to": "Item",
      "nav": "to",                    // arrowhead at "to". Also "from", "both", "none"
      "toMult": ["*"],                // accepted multiplicities next to "to". Add "" to allow blank
      "toRole": ["items"],            // accepted role names next to "to"
      "typeHint": "Inventory keeps a List of Items in a field."
    },
    { "type": "dependency", "from": "Inventory", "to": "Billable", "optional": true }
  ]
}
```

Direction rules for `from` → `to`:

| type | from | to |
| --- | --- | --- |
| inheritance, realization | child / implementing class | parent / interface |
| dependency | user | used |
| association | class that holds the reference | referenced class |
| composition, aggregation | whole (diamond end) | part |

Things the grader does without being told:

- Flags a reference shown both as an attribute and as a line (uses the role names).
- Flags a reference shown only as an attribute, once, with a "draw it as a line" message.
- Flags Java-style members (`private String name`, `int getCount()`).
- Accepts `void` or no return type for void methods, and parameter types without names (as a note).
- Treats `*` and `0..*` as the same.
- Flags any class or line that is not in the key.

### Key for an object diagram

```jsonc
"key": {
  "objects": [
    { "ref": "inv", "class": ["Inventory"],
      "forbidAttrs": { "items": "items is shown by the link. Don't also list it." } },
    { "ref": "item", "class": ["StockItem"],
      "wrongClass": { "Item": "Show it as :StockItem, its real class." },
      "attrs": [{ "name": "name", "value": ["spanner"] }] }
  ],
  "links": [{ "a": "inv", "b": "item" }],
  "extraObjectHints": { "Item": "There is only one item object." }
}
```

Values are compared without quotes, so `"spanner"` and `spanner` both match.

### Sequence diagrams

A sequence part has `"mode": "sequence"`. Its diagrams use `lifelines` and `rows` instead of nodes and edges:

```jsonc
"model": {
  "lifelines": [
    { "id": "cart", "name": ":Cart", "kind": "object" },       // kind: object | class (static) | actor
    { "id": "receipt", "name": "Receipt", "kind": "class" }
  ],
  "rows": [                                                     // top to bottom
    { "id": "r1", "type": "call", "from": "@start", "to": "cart", "label": "checkout(c)" },
    { "id": "r2", "type": "frame", "frame": "loop", "guard": "for each item" },
    { "id": "r3", "type": "call", "from": "cart", "to": "item", "label": "getPrice()" },
    { "id": "r4", "type": "return", "from": "item", "to": "cart", "label": "price" },
    { "id": "r5", "type": "end" }
  ]
}
```

Row types: `call`, `return`, `create`, `delete`, `frame` (with `frame`: loop, alt, opt or par, and `guard`), `else` (with `guard`), `end`. `@start` is the start dot for the first incoming call. Activation bars are not stored; they follow from the calls and returns.

The key describes the expected call tree, not the drawing:

```jsonc
"key": {
  "lifelines": [
    { "ref": "cart", "class": "Cart" },
    { "ref": "loan", "class": "Loan", "created": true },
    { "ref": "receipt", "class": "Receipt", "static": true, "staticHint": "print" }
  ],
  "entry": { "to": "cart", "method": "checkout", "args": 1, "returns": "total" },
  "body": [                                   // what happens inside the entry call, in order
    { "frame": "loop", "branches": [{ "guardExample": "[for each item]", "body": [
      { "call": "item", "method": "getPrice", "args": 0, "returns": "price" }
    ] }] },
    { "call": "cart", "method": "applyDiscount", "args": 2, "returns": "total",
      "body": [ { "call": "c", "method": "isMember", "args": 0 } ] },   // nested calls
    { "create": "loan", "args": 2 },
    { "call": "receipt", "method": "print", "args": 1 }
  ]
}
```

- `returns` marks a method that returns a value. A missing return arrow is a note (minimal notation); a labelled return on a void method is an error.
- `args` is the argument count; names are not checked.
- Lifeline names are not checked beyond the `:Class` / `name:Class` format.
- A frame with no calls inside, a call in the wrong activation, or the wrong frame type are errors.
- An `alt` frame lists one entry in `branches` per part; `loop` and `opt` have one. Mark a trailing branch `"optional": true` if it may be left out, e.g. an empty `[else]` for a switch's default.

Sequence examples patch rows instead of edges: `"rows": { "r3": { "to": "b" } }`, `"removeRows"`, `"addRows": [{ "after": "r8", "row": { ... } }]`, `"lifelines": { ... }`, or `"order": [every row id in the new order]`.

### Activity diagrams

An activity part has `"mode": "activity"`. Activity questions usually describe a process in words, so `code` can hold a `.txt` file (it is shown as plain text, not Java). The diagram uses nodes and flows:

```jsonc
"model": {
  "nodes": [
    { "id": "start", "kind": "start", "name": "", "x": 487, "y": 20 },
    { "id": "scan", "kind": "action", "name": "Scan parcel", "x": 440, "y": 200 },
    { "id": "d1", "kind": "decision", "name": "", "x": 480, "y": 270 },       // branch or merge diamond
    { "id": "fork", "kind": "bar", "name": "", "x": 300, "y": 480, "w": 400 }, // fork or join bar
    { "id": "end1", "kind": "end", "name": "", "x": 758, "y": 420 }
  ],
  "edges": [
    { "id": "f5", "type": "flow", "from": "d1", "to": "aside", "guard": "not recognised" },
    { "id": "f19", "type": "flow", "from": "d3", "to": "m1", "guard": "more parcels", "route": "right" } // around the right or left, for loops
  ]
}
```

The key lists the actions and the flows between them:

```jsonc
"key": {
  "actions": [
    { "ref": "scan", "label": "Scan parcel", "name": ["scan"] },            // label: shown in feedback
    { "ref": "aside", "label": "Set parcel aside", "name": ["aside", "depot"] }
  ],
  "flows": [
    { "from": "start", "to": "login" },
    { "from": "scan", "to": "aside", "guard": ["not recognised", "unknown", "invalid"] },
    { "from": ["aside", "delivered"], "to": "scan", "guard": ["more parcels", "more"] }, // two paths into one place
    { "from": "open", "to": ["place", "send"], "via": "fork" },             // one fork
    { "from": ["place", "send"], "to": "delivered", "via": "join" },        // one join
    { "from": "login", "to": "logout", "optional": true }                   // another accepted way to draw it
  ],
  "allowExtra": ["close door"]        // extra actions that are not counted as mistakes
}
```

How it is graded:
- **Actions match by their words.** A student's action matches when it contains every word of one `name` phrase. Word order, filler words ("the", "a", "to"), plurals and -ed/-ing endings are ignored, and "not"/"no" must agree. So `["scan"]` matches "Scan the barcode", and `["no more"]` does not match "more parcels". Keep phrases short.
- **Flows are compared step by step.** The student's diagram is reduced to steps from one action (or start/end) to the next, through any diamonds and bars. So a separate merge diamond, a combined merge+branch diamond, or one 3-way diamond in place of two nested ones all grade the same. `from` and `to` are action refs, `"start"` or `"end"`.
- **Guards match the same way** as action names, against any guard on the path. The first phrase is shown in feedback, so make it the clearest. Include `""` if no guard is needed. A guard that matches nothing in the list is a partial (½), because it may just be other words. A guard that belongs to another flow from the same place is an error (swapped guards).
- `via: "fork"` needs a fork bar on the path and `via: "join"` a join bar. A path through a bar where the key has no `via` is an error.
- **One mistake, one deduction.** A missing action costs one mark if the student joined up the steps around it. An extra action costs one mark and does not break the flows through it. An action worded differently but in the right place is a partial (½).
- Checked without a key: one start node, at least one end node, a guard on every flow out of a branch, different guards on one branch, nothing flowing into a start or out of an end. Two flows leaving an action, or two entering one directly, are partials (½): use a diamond or a bar. [yes]/[no] guards out of a diamond with a question in it are read using the question, with a note.

`mistakes` on an activity flow can match `to` (the path goes to that ref instead), `guard` (the student's guard says this), or `via`: `"sequence"` (parallel steps drawn one after the other), `"decision"` (a branch diamond where the key has a fork), `"merge"` (a merge diamond where the key has a join) or `"fork"` (a bar where nothing runs in parallel).

The score is one mark per action, one for the start node, one for an end node, and one per required flow.

## Handling ambiguity

CS2103T marking is flexible, and questions will often be ambiguous. Encode that in the key instead of picking one answer:

| Situation | How to encode it |
| --- | --- |
| Two kinds of line are both fine | `"acceptTypes": ["composition"]` plus `"acceptNote"` |
| A line is fine but not required | `"optional": true` |
| Attribute form is also accepted | `"orAttribute": { "name": "rating", "vis": "-", "type": ["Rating"] }` |
| Multiplicity is unknown from the code | include `""` in `toMult`, e.g. `["", "0..1", "1"]` |
| A member may be drawn or left out | put it in `optionalMethods` / `optionalAttrs` |
| An object attribute can be a linked object | `"orLinkedObject": { "class": "Rating", "name": ["POOR"] }` |
| A two-way association may be one line or two one-way lines | `"nav": "both"` with `fromMult`/`fromRole`, plus `"orTwoLines": true` |
| An `alt` part may be left out (an empty `[else]`, say) | `"optional": true` on that branch; optional branches go last |
| An answer is half right | a `mistakes` entry with `"credit": 0.5` (see below) |
| An action can be worded several ways | more phrases in its `name`, e.g. `["log out", "logout", "sign out"]` |
| An activity can be drawn along a different valid path | add that flow with `"optional": true` |

Accepted alternatives show up as **notes**, not errors. If you're unsure whether something is acceptable, make it accepted with a note, and say so in the PR so a reviewer can decide.

## Scores, partial credit and known mistakes

Every part is scored. It is worth one mark per thing the key checks: each class, required attribute and method, required relation (two for `orTwoLines`), object, object attribute and link, lifeline, call, creation and frame, and each action, required flow, start and end node. Set `"marks"` on the part to override the total. An **error** costs 1 mark, a **partial** costs `1 - credit`, and a **note** is free.

`mistakes` names common wrong answers and says exactly what to tell the student. When the drawing matches one, its `msg` replaces the generic message. Add `credit` (between 0 and 1) to make it partly right instead of wrong:

```jsonc
// on a relation: match a line type, or a multiplicity or role at either end
"mistakes": [
  { "type": "aggregation", "credit": 0.5, "msg": "Route creates its Stops and nothing else holds them, so use composition." },
  { "toMult": "0..5", "credit": 0.5, "msg": "The constructor always adds two Stops, so 2..5." },
  { "toMult": ["*", "1..*"], "msg": "The array has room for only 5 Stops." }
]
// on a sequence call: the right method sent to the wrong lifeline, or the wrong method in its place
"mistakes": [
  { "to": "tray", "msg": "t.getOven() returns the Oven, so heat(1) goes to the Oven." },
  { "method": "heat", "msg": "Kitchen calls finish(); heat(5) is a self-call inside it." }
]
// on a sequence frame: the wrong kind of frame
"mistakes": [{ "frame": "opt", "credit": 0.5, "msg": "The cases exclude each other: use one alt frame." }]
// on an activity flow: where the path goes instead, a guard, or how parallel steps were drawn
"mistakes": [
  { "to": "login", "credit": 0.5, "msg": "The courier logs in once; the loop goes back to scanning." },
  { "via": "merge", "credit": 0.5, "msg": "Wait for both: use a join bar, not a merge diamond." }
]
```

Only give credit where a marker would give part marks: the idea is right but the notation is off, or the answer is close. A partly right line is still checked for direction, multiplicities and roles.

The grader also handles some common mistakes without being told:
- Several `opt` frames in a row where the key has an `alt` count as one mistake, and their calls are graded as the parts of the `alt`.
- A link to an extra object is not counted on top of the object itself.
- When a frame is the wrong kind, the calls inside it are compared as a whole, not part by part.

## Examples (tests)

Each part should have at least three `examples`. Each one patches the model answer to make a common mistake and states the expected count:

```jsonc
{
  "name": "items shown as attribute and as a line",
  "expect": { "errors": 1 },          // also "partials", "notes", "score", or "errorsAtLeast"
  "patch": {
    "nodes": { "inventory": { "attrs": ["-items: List<Item>"] } },  // overwrite fields by node id
    "edges": { "m5": { "navTo": false } },                           // overwrite fields by edge id
    "removeEdges": ["m6"], "removeNodes": [],
    "addNodes": [], "addEdges": []
  }
}
```

An example can also hold a full `"diagram"` instead of a `"patch"`; author mode does this when a patch can't describe the change.

`node scripts/check.js` fails if the model answer has any error, or if an example's count differs. Run it with `-v` to see every message.

Good mistakes to cover: wrong arrow direction, missing navigability, multiplicity at the wrong end, attribute and line both shown, Java-style members, missing `{abstract}` or `<<interface>>`, and (for object diagrams) multiplicities on links or the same object drawn twice.

## Pull request checklist

- [ ] `node scripts/check.js` passes.
- [ ] The file is listed in `questions/index.json`.
- [ ] The question is original, and `source` says where the idea came from.
- [ ] At least three examples per part.
- [ ] I tried the question in the app and the messages read clearly.
- [ ] Any judgement calls on accepted alternatives are listed in the PR description.

## Changing the grader

Grader changes affect every question, so open an issue first. Then edit `grader.js` (no DOM, runs in Node and the browser) and make sure `node scripts/check.js` still passes for all questions. Add an example that covers the new behaviour.

## Using an AI agent

You can ask Claude, Copilot or another agent to write a question for you. Point it at `AGENTS.md`, which has step-by-step instructions. You are still responsible for the PR: read the key and run the check yourself.
