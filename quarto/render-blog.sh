#!/bin/sh
set -eu

quarto render blog.qmd
quarto render blog/icml-update.qmd
quarto render blog/going-viral.qmd
quarto render blog/welcome.qmd
