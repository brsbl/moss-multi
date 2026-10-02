:::tabs
=== Option A
Content for **A** with {{2+2|4}}.

=== Option B
- list in B
- second

=== Option C
| Col | Val |
| --- | --- |
| x | 1 |

:::


:::tabs
=== Code
```javascript
const fence = ':::';
```

=== Callout
```moss-callout
info
Inside a tab.
```

:::


:::tabs
=== Outer
:::tabs
=== Inner
nested tabs stay text
:::

:::


:::tabs
Content before the first header keeps this as text.
=== Late
late
:::

:::tabs
=== Empty

=== Filled
filled

:::
