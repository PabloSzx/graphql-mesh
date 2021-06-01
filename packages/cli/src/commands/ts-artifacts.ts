import { Maybe, RawSourceOutput, YamlConfig } from '@graphql-mesh/types';
import * as tsBasePlugin from '@graphql-codegen/typescript';
import * as tsResolversPlugin from '@graphql-codegen/typescript-resolvers';
import { GraphQLSchema, GraphQLObjectType, NamedTypeNode, Kind } from 'graphql';
import { codegen } from '@graphql-codegen/core';
import { serverSideScalarsMap } from './scalars-map';
import { pascalCase } from 'pascal-case';
import { Source } from '@graphql-tools/utils';
import * as tsOperationsPlugin from '@graphql-codegen/typescript-operations';
import * as tsGenericSdkPlugin from '@graphql-codegen/typescript-generic-sdk';

const unifiedContextIdentifier = 'MeshContext';

class CodegenHelpers extends tsBasePlugin.TsVisitor {
  public getTypeToUse(namedType: NamedTypeNode): string {
    if (this.scalars[namedType.name.value]) {
      return this._getScalar(namedType.name.value);
    }

    return this._getTypeForNode(namedType);
  }
}

function buildSignatureBasedOnRootFields(
  codegenHelpers: CodegenHelpers,
  type: Maybe<GraphQLObjectType>
): Record<string, string> {
  if (!type) {
    return {};
  }

  const fields = type.getFields();
  const operationMap: Record<string, string> = {};
  for (const fieldName in fields) {
    const field = fields[fieldName];
    const argsExists = field.args && field.args.length > 0;
    const argsName = argsExists ? `${type.name}${codegenHelpers.convertName(field.name)}Args` : '{}';
    const parentTypeNode = {
      kind: Kind.NAMED_TYPE,
      name: {
        kind: Kind.NAME,
        value: type.name,
      },
    };
    operationMap[fieldName] = `  ${field.name}: (args${
      argsExists ? '' : '?'
    }: ${argsName}, projectionOptions?: ProjectionOptions) => Promise<${codegenHelpers.getTypeToUse(
      parentTypeNode
    )}['${fieldName}']>`;
  }
  return operationMap;
}

function generateTypesForApi(options: { schema: GraphQLSchema; name: string }) {
  const codegenHelpers = new CodegenHelpers(options.schema, {}, {});
  const sdkIdentifier = pascalCase(`${options.name}Sdk`);
  const contextIdentifier = pascalCase(`${options.name}Context`);
  const queryOperationMap = buildSignatureBasedOnRootFields(codegenHelpers, options.schema.getQueryType());
  const mutationOperationMap = buildSignatureBasedOnRootFields(codegenHelpers, options.schema.getMutationType());
  const subscriptionsOperationMap = buildSignatureBasedOnRootFields(
    codegenHelpers,
    options.schema.getSubscriptionType()
  );
  const operationMap = Object.assign({}, subscriptionsOperationMap, mutationOperationMap, queryOperationMap);

  const sdk = {
    identifier: sdkIdentifier,
    codeAst: `export type ${sdkIdentifier} = {
${Object.values(operationMap).join(',\n')}
};

export type Query${sdkIdentifier} = {
${Object.values(queryOperationMap).join(',\n')}
};

export type Mutation${sdkIdentifier} = {
${Object.values(mutationOperationMap).join(',\n')}
};

export type Subscription${sdkIdentifier} = {
${Object.values(subscriptionsOperationMap).join(',\n')}
};`,
  };

  const context = {
    identifier: contextIdentifier,
    codeAst: `export type ${contextIdentifier} = { 
      ["${options.name}"]: { api: ${sdkIdentifier}, apiQuery: Query${sdkIdentifier}, apiMutation: Mutation${sdkIdentifier}, apiSubscription: Subscription${sdkIdentifier} }, 
    };`,
  };

  return {
    sdk,
    context,
  };
}

export async function generateTsArtifacts({
  unifiedSchema,
  rawSources,
  mergerType = 'stitching',
  documents,
  flattenTypes,
  rawConfig,
}: {
  unifiedSchema: GraphQLSchema;
  rawSources: RawSourceOutput[];
  mergerType: string;
  documents: Source[];
  flattenTypes: boolean;
  rawConfig: YamlConfig.Config;
}) {
  const codegenOutput = await codegen({
    filename: 'types.ts',
    documents,
    config: {
      scalars: serverSideScalarsMap,
      skipTypename: true,
      flattenGeneratedTypes: flattenTypes,
      onlyOperationTypes: flattenTypes,
      preResolveTypes: flattenTypes,
      namingConvention: 'keep',
      documentMode: 'documentNode',
    },
    schemaAst: unifiedSchema,
    schema: undefined as any, // This is not necessary on codegen.
    skipDocumentsValidation: true,
    pluginMap: {
      typescript: tsBasePlugin,
      typescriptOperations: tsOperationsPlugin,
      typescriptGenericSdk: tsGenericSdkPlugin,
      resolvers: tsResolversPlugin,
      contextSdk: {
        plugin: async () => {
          const commonTypes = [
            `import { MeshContext as BaseMeshContext, ProjectionOptions } from '@graphql-mesh/runtime';`,
          ];
          const sdkItems: string[] = [];
          const contextItems: string[] = [];
          const results = await Promise.all(
            rawSources.map(source => {
              const sourceMap = unifiedSchema.extensions.sourceMap as Map<RawSourceOutput, GraphQLSchema>;
              let sourceSchema = sourceMap.get(source);
              if (!sourceSchema) {
                for (const [keySource, valueSchema] of sourceMap.entries()) {
                  if (keySource.name === source.name) {
                    sourceSchema = valueSchema;
                  }
                }
              }
              const item = generateTypesForApi({
                schema: sourceSchema,
                name: source.name,
              });

              if (item) {
                if (item.sdk) {
                  sdkItems.push(item.sdk.codeAst);
                }
                if (item.context) {
                  contextItems.push(item.context.codeAst);
                }
              }
              return item;
            })
          );

          const contextType = `export type ${unifiedContextIdentifier} = ${results
            .map(r => r?.context?.identifier)
            .filter(Boolean)
            .join(' & ')} & BaseMeshContext;`;

          return {
            content: [...commonTypes, ...sdkItems, ...contextItems, contextType].join('\n\n'),
          };
        },
      },
    },
    plugins: [
      {
        typescript: {},
      },
      {
        resolvers: {
          useIndexSignature: true,
          noSchemaStitching: mergerType !== 'stitching',
          contextType: unifiedContextIdentifier,
          federation: mergerType === 'federation',
        },
      },
      {
        contextSdk: {},
      },
      {
        typescriptOperations: {},
      },
      {
        typescriptGenericSdk: {},
      },
    ],
  });
  return [
    codegenOutput,
    /* TypeScript */ `
import { findAndParseConfig, ConfigProcessOptions } from '@graphql-mesh/config';
import { getMesh } from '@graphql-mesh/runtime';
import { join } from 'path';
import { MeshStore, FsStoreStorageAdapter } from '@graphql-mesh/store';

export async function getBuiltMesh(configProcessOptions: ConfigProcessOptions = {}) {
  const meshConfig = await findAndParseConfig(
    {
      dir: join(__dirname, '..'),
      store: new MeshStore(join(__dirname, '../.mesh'), new FsStoreStorageAdapter(), {
        readonly: true,
        validate: false
      }),
      ...configProcessOptions
    }
  );
  return getMesh(meshConfig);
}

export async function getMeshSDK() {
  const { sdkRequester } = await getBuiltMesh();
  return getSdk(sdkRequester);
}
      `,
  ].join('\n');
}