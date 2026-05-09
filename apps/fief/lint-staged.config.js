import { lstatSync } from "node:fs";

import baseConfig from "../../lint-staged.config.js";

const dropSymlinks = (files) =>
  files.filter((file) => {
    try {
      return !lstatSync(file).isSymbolicLink();
    } catch {
      return true;
    }
  });

/**
 * @type {import('lint-staged').Configuration}
 */
export default {
  ...baseConfig,
  /*
   * Function form: lstat each staged file and drop symlinks before handing
   * the list to ESLint + Prettier. Prettier explicitly rejects symbolic-link
   * inputs (even when listed in .prettierignore), and `apps/fief/graphql/
   * schema.graphql` is a symlink to the workspace-shared Saleor schema.
   * Identical pattern works for any future symlinked .graphql sources.
   */
  "*.{jsx,tsx,ts,js,graphql}": (files) => {
    const real = dropSymlinks(files);
    if (real.length === 0) return [];
    const list = real.join(" ");
    return [`eslint --cache --fix ${list}`, `prettier --write ${list}`];
  },
};
