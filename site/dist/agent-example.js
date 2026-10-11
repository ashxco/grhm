export const agentExample = {
  "source": "(app catalog\n  (page \"/\" home\n    (grid :id \"product-grid\"\n      :cols 4 :gap 16\n      (txt \"Books\")\n      (txt \"Music\")\n      (txt \"Film\")\n      (txt \"Art\"))))",
  "revision": "c73a09f0",
  "patch": "(patch :revision \"c73a09f0\"\n  :target product-grid\n  (set cols 3))",
  "result": {
    "schema": 1,
    "ok": true,
    "revision": "66612957",
    "conflict": false,
    "changed": [
      "product-grid"
    ],
    "diagnostics": [],
    "changedFiles": [
      "app.grhm"
    ]
  },
  "after": "(app catalog\n  (page \"/\" home\n    (grid :id \"product-grid\" :cols 3 :gap 16\n      (txt \"Books\")\n      (txt \"Music\")\n      (txt \"Film\")\n      (txt \"Art\"))))\n",
  "broken": "(app hello\n  (page \"/\" home\n    (txt \"Hello\" :id \"greeting\" :colr \"#d3f5a2\")))",
  "diagnostic": {
    "schema": 1,
    "code": "E102",
    "severity": "error",
    "message": "\"text\" has no property \":colr\"",
    "span": {
      "start": 60,
      "end": 65,
      "line": 3,
      "col": 33
    },
    "nodeId": "greeting",
    "op": "text",
    "field": "colr",
    "expected": "align align-md align-sm bg bg-md bg-sm border border-md border-sm color color-md color-sm delay dur ease enter gap gap-md gap-sm grow grow-md grow-sm h h-md h-sm hover id justify justify-md justify-sm margin margin-md margin-sm max-w max-w-md max-w-sm pad pad-md pad-sm radius radius-md radius-sm shadow shadow-md shadow-sm size size-md size-sm stagger w w-md w-sm weight weight-md weight-sm wrap wrap-md wrap-sm",
    "suggestions": [
      ":color"
    ],
    "fixes": [
      {
        "id": "f83575753",
        "title": "Replace \":colr\" with \":color\"",
        "confidence": "safe",
        "edits": [
          {
            "start": 60,
            "end": 65,
            "text": ":color"
          }
        ]
      }
    ]
  }
};
