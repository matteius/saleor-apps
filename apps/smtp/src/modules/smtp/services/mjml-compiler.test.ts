import { describe, expect, it } from "vitest";

import { MjmlCompiler } from "./mjml-compiler";

describe("MjmlCompiler", () => {
  it("Compiles MJML syntax to HTML", async () => {
    const compiler = new MjmlCompiler();

    const result = await compiler.compile(`
      <mjml>
          <mj-body>
              <mj-section>
                  <mj-column>
                      <mj-text >{{injectedValue}}</mj-text>
                  </mj-column>
              </mj-section>
          </mj-body>
      </mjml>
    `);

    const html = result._unsafeUnwrap();

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("{{injectedValue}}");
    expect(html).toContain("</html>");
  });

  it("Returns error if mjml syntax is broken", async () => {
    const compiler = new MjmlCompiler();

    const result = await compiler.compile(`
      2137
    `);

    expect(result._unsafeUnwrapErr()).toBeInstanceOf(MjmlCompiler.FailedToCompileError);
  });
});
