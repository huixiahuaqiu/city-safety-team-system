# Module HTML fragments

Lazy-loaded UI fragments live here as `{id}.html`, where `{id}` matches a DOM element id in `index.html`.

## Convention

- Target element: `#<id>` with `data-lazy="1"` and empty (or near-empty) inner HTML.
- Loader: `js/module-loader.js` exposes `window.loadModuleHtml(id)`.
- After a successful fetch, the element gets `data-loaded="1"`.

## Example

```html
<div id="my-panel" data-lazy="1"></div>
<script>
  loadModuleHtml('my-panel');
</script>
```

Place `modules/my-panel.html` beside this README.
