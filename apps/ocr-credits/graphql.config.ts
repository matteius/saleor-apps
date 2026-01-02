import type { IGraphQLConfig } from "graphql-config";

const config: IGraphQLConfig = {
  projects: {
    default: {
      schema: "graphql/schema.graphql",
      documents: ["graphql/**/*.graphql"],
      extensions: {
        codegen: {
          generates: {
            "generated/graphql.ts": {
              plugins: [
                "typescript",
                "typescript-operations",
                "typed-document-node",
              ],
              config: {
                strictScalars: false,
                skipTypename: true,
                avoidOptionals: false,
                enumsAsTypes: true,
                dedupeFragments: true,
              },
            },
          },
        },
      },
    },
  },
};

export default config;

