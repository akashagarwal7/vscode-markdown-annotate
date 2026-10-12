---
name: release
description: Release the extension. Bump the version, update the CHANGELOG, commit, push to origin, and publish to the VS Code Marketplace. Use when the user asks to release, publish, ship or bump the version.
argument-hint: "[patch|minor|major|<x.y.z>]"
---

# Release

Takes the bump as an argument: `patch`, `minor`, `major`, or an exact version. Without one, pick it from what changed since the last release: `minor` for new features, `patch` for fixes only (the project is pre-1.0, so breaking changes are `minor` too). State which one you picked.

## 1. Check the tree

- You must be on `master`. Run `git fetch` and stop if `origin/master` has commits that are not in local `master`.
- Uncommitted work that belongs in the release gets its own commit first, with a message describing the change. Ask before including anything that looks unrelated or unfinished.
- `npm test` and `npx tsc --noEmit -p .` must pass. Stop and report if either fails.

## 2. Bump and write the changelog

- `npm version <bump> --no-git-tag-version`. This updates `package.json` and `package-lock.json`. The project has no release tags.
- Find the last release commit with `git log --grep '^Release ' -1`, then read the commits since it with `git log <that>..HEAD`.
- Add a `## <version>` section at the top of `CHANGELOG.md`. Write it in the style of the existing entries: one bullet per change a user would notice, with the UI names in bold. Leave out internal refactors, tests, docs and repo housekeeping.
- If the README describes behaviour that changed, update it too.

## 3. Update the screenshots

Retake the README screenshots (`docs/preview-light.png`, `docs/preview-dark.png`) if the preview looks different since they were last taken. That covers a new header control, a changed style, or a new feature the demo could show. Skip this step if nothing visible changed, and say so.

- Build the harness: `npm run harness`.
- With the Chrome DevTools MCP tools, emulate a `860x636x2` viewport. Open `test/harness/index.html?demo` for light and `test/harness/index.html?demo&dark` for dark, and save a viewport screenshot of each over the files in `docs/`.
- The `?demo` content and its committed base live in `test/harness/harness.ts`. If a new feature isn't visible in the demo, extend the demo to show it, keeping the shot within the viewport. Then look at both images before using them.
- Commit the screenshots (and any harness change) on their own, before the release commit.

## 4. Commit and push

- Commit `package.json`, `package-lock.json`, `CHANGELOG.md` (and the README, if it changed) as `Release <version>: <one-line summary>`. The body lists the changes as bullets, as in earlier release commits.
- `git push origin master`.

## 5. Publish

- Run `./publish.sh`. It installs, tests, and publishes with `vsce`. It needs a login (`vsce login akashagarwal`) or a `VSCE_PAT` in the environment. If it fails on auth, ask the user to run `! npx @vscode/vsce login akashagarwal`, then run it again. The commit is already pushed, so don't redo steps 1–4.
- Report the published version and the Marketplace link: https://marketplace.visualstudio.com/items?itemName=akashagarwal.vscode-markdown-annotate. The listing can take a few minutes to update.
- Then remind the user to reinstall locally (`./install.sh`, see CLAUDE.md).
