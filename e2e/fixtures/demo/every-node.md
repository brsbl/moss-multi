Every node family moss renders, in one shared note. A paragraph with **bold**, *italic*, <u>underline</u>, ~~strike~~, `inline code`, ==a highlight== and a [link](https://example.com/docs).

# Heading one

## Heading two

### Heading three

- A bullet
- Another bullet
    - A nested bullet

1. First step
2. Second step

- [ ] An open task
- [x] A finished task

Inline nodes: a formula {{2+3|5}}, a named value {{timeline|6 weeks}}, a wiki link [[Launch plan]] and a color #ff8800.

> A quote with **bold** words.

| Family | Where |
| --- | --- |
| Table | here |
| Chart | below |

```moss-callout
warning
A callout, for the one thing a reader must not miss.
```

:::tabs
=== Web
The web build renders this panel.
=== Desktop
Moss desktop renders the same panel.
:::

```ts
const answer: number = 42;
```

```moss-chart
{"type":"line","title":"Edits per day","data":[{"label":"Mon","value":12},{"label":"Tue","value":18},{"label":"Wed","value":9},{"label":"Thu","value":24}]}
```

```moss-canvas
[moss:grid:v2]
[moss:labels:[{"id":"box","text":"Sketch","col":8,"row":4}]]
....############
....#..........#
....############
```

```moss-html
<div style="font-family: system-ui, sans-serif; padding: 12px">
  <button id="run" style="font: inherit; padding: 6px 12px">Run the numbers</button>
  <p id="out">Click the button to run this block's script.</p>
  <script>
    document.getElementById('run').addEventListener('click', () => {
      document.getElementById('out').textContent = 'Ran on click: 200 teams x 5 editors = ' + 200 * 5 + ' seats.';
    });
  </script>
</div>
```

---

Media uploaded from this machine:
