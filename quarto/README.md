# Blog Rendering

The blog source files are Quarto documents:

- `blog.qmd`
- `blog/icml-update.qmd`
- `blog/going-viral.qmd`
- `blog/welcome.qmd`

After installing Quarto, render the live HTML pages from the repository root:

```sh
sh quarto/render-blog.sh
```

The generated pages keep the existing public URLs:

- `blog.html`
- `blog/icml-update.html`
- `blog/going-viral.html`
- `blog/welcome.html`
