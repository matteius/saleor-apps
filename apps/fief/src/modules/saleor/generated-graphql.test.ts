import {
  type DefinitionNode,
  type FragmentDefinitionNode,
  Kind,
  type OperationDefinitionNode,
  type SelectionNode,
} from "graphql";
import { describe, expect, it } from "vitest";

import {
  FiefCustomerCreateDocument,
  type FiefCustomerCreateMutation,
  type FiefCustomerCreateMutationVariables,
  type FiefCustomerFragment,
  FiefCustomerFragmentDoc,
  FiefMeDocument,
  type FiefMeQuery,
  type FiefMeQueryVariables,
} from "@/generated/graphql";

/**
 * Smoke test for the T7 codegen output.
 *
 * `reason_not_testable: codegen task; verification by static check` — this file
 * exists to confirm the generated documents (a) compile against the rest of the
 * app at the type level and (b) are valid GraphQL Document ASTs at runtime.
 *
 * If this test ever stops compiling, the codegen contract has drifted from the
 * fragments we hand-wrote in `apps/fief/graphql/`.
 */
describe("generated GraphQL documents", () => {
  it("FiefCustomerFragmentDoc is a valid Document AST", () => {
    expect(FiefCustomerFragmentDoc.kind).toBe(Kind.DOCUMENT);
    expect(FiefCustomerFragmentDoc.definitions.length).toBeGreaterThan(0);

    const def = FiefCustomerFragmentDoc.definitions[0] as DefinitionNode;

    expect(def.kind).toBe(Kind.FRAGMENT_DEFINITION);

    const fragment = def as FragmentDefinitionNode;

    expect(fragment.name.value).toBe("FiefCustomer");
    expect(fragment.typeCondition.name.value).toBe("User");

    const fieldNames = fragment.selectionSet.selections
      .filter((s: SelectionNode) => s.kind === Kind.FIELD)
      .map((s) => (s.kind === Kind.FIELD ? s.name.value : ""));

    expect(fieldNames).toStrictEqual(
      expect.arrayContaining([
        "id",
        "email",
        "firstName",
        "lastName",
        "isActive",
        "metadata",
        "privateMetadata",
      ]),
    );
  });

  it("FiefCustomerCreateDocument is a valid Document AST", () => {
    expect(FiefCustomerCreateDocument.kind).toBe(Kind.DOCUMENT);

    const op = FiefCustomerCreateDocument.definitions.find(
      (d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION,
    );

    expect(op).toBeDefined();
    expect(op?.operation).toBe("mutation");
    expect(op?.name?.value).toBe("FiefCustomerCreate");
  });

  it("FiefMeDocument is a valid Document AST", () => {
    expect(FiefMeDocument.kind).toBe(Kind.DOCUMENT);

    const op = FiefMeDocument.definitions.find(
      (d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION,
    );

    expect(op).toBeDefined();
    expect(op?.operation).toBe("query");
    expect(op?.name?.value).toBe("FiefMe");
  });

  it("exposes branded TypeScript types for variables and result shapes", () => {
    /*
     * These are pure type-level assertions — they don't run anything but they
     * do verify the codegen emits the names we expect.
     */
    const customerInput: FiefCustomerCreateMutationVariables = {
      input: { email: "test@example.com" },
    };
    const customerResult: FiefCustomerCreateMutation | undefined = undefined;
    const customer: FiefCustomerFragment | undefined = undefined;
    const me: FiefMeQuery | undefined = undefined;
    const meVars: FiefMeQueryVariables = {};

    expect(customerInput.input.email).toBe("test@example.com");
    expect(customerResult).toBeUndefined();
    expect(customer).toBeUndefined();
    expect(me).toBeUndefined();
    expect(meVars).toStrictEqual({});
  });
});
