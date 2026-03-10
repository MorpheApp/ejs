import { type ESTree } from "meriyah";
import { matchesStructure } from "../../utils.ts";
import { type DeepPartial } from "../../types.ts";

const identifier: DeepPartial<ESTree.Node> = {
  or: [
    {
      type: "VariableDeclaration",
      kind: "var",
      declarations: {
        anykey: [
          {
            type: "VariableDeclarator",
            id: {
              type: "Identifier",
            },
            init: {
              type: "ArrayExpression",
              elements: [
                {
                  type: "Identifier",
                },
              ],
            },
          },
        ],
      },
    },
    {
      type: "ExpressionStatement",
      expression: {
        type: "AssignmentExpression",
        left: {
          type: "Identifier",
        },
        operator: "=",
        right: {
          type: "ArrayExpression",
          elements: [
            {
              type: "Identifier",
            },
          ],
        },
      },
    },
  ],
} as const;

const catchBlockBody = [
  {
    type: "ReturnStatement",
    argument: {
      type: "BinaryExpression",
      left: {
        type: "MemberExpression",
        object: {
          type: "Identifier",
        },
        computed: true,
        property: {
          type: "Literal",
        },
        optional: false,
      },
      right: {
        type: "Identifier",
      },
      operator: "+",
    },
  },
] as const;

export function extract(
  node: ESTree.Node,
): ESTree.ArrowFunctionExpression | null {
  if (!matchesStructure(node, identifier)) {
    // Fallback search for try { } catch { return X[12] + Y }
    let name: string | undefined | null = null;
    let block: ESTree.BlockStatement | null | undefined = null;
    switch (node.type) {
      case "ExpressionStatement": {
        if (
          node.expression.type === "AssignmentExpression" &&
          node.expression.left.type === "Identifier" &&
          node.expression.right.type === "FunctionExpression" &&
          node.expression.right.params.length === 1
        ) {
          name = node.expression.left.name;
          block = node.expression.right.body;
        }
        break;
      }
      case "FunctionDeclaration": {
        if (node.params.length === 1) {
          name = node.id?.name;
          block = node.body;
        }
        break;
      }
    }
    if (!block || !name) {
      return null;
    }
    const tryNode = block.body.at(-2);
    if (
      tryNode?.type !== "TryStatement" ||
      tryNode.handler?.type !== "CatchClause"
    ) {
      return null;
    }
    const catchBody = tryNode.handler!.body.body;
    if (matchesStructure(catchBody, catchBlockBody)) {
      return makeSolverFuncFromName(name);
    }
    return extractFromNRole(node);
  }

  if (node.type === "VariableDeclaration") {
    for (const declaration of node.declarations) {
      if (
        declaration.type !== "VariableDeclarator" ||
        !declaration.init ||
        declaration.init.type !== "ArrayExpression" ||
        declaration.init.elements.length !== 1
      ) {
        continue;
      }
      const [firstElement] = declaration.init.elements;
      if (firstElement && firstElement.type === "Identifier") {
        return makeSolverFuncFromName(firstElement.name);
      }
    }
  } else if (node.type === "ExpressionStatement") {
    const expr = node.expression;
    if (
      expr.type === "AssignmentExpression" &&
      expr.left.type === "Identifier" &&
      expr.operator === "=" &&
      expr.right.type === "ArrayExpression" &&
      expr.right.elements.length === 1
    ) {
      const [firstElement] = expr.right.elements;
      if (firstElement && firstElement.type === "Identifier") {
        return makeSolverFuncFromName(firstElement.name);
      }
    }
  }
  return extractFromNRole(node);
}

function makeSolverFuncFromName(name: string): ESTree.ArrowFunctionExpression {
  return {
    type: "ArrowFunctionExpression",
    params: [
      {
        type: "Identifier",
        name: "n",
      },
    ],
    body: {
      type: "CallExpression",
      callee: {
        type: "Identifier",
        name: name,
      },
      arguments: [
        {
          type: "Identifier",
          name: "n",
        },
      ],
      optional: false,
    },
    async: false,
    expression: false,
    generator: false,
  };
}

function extractFromNRole(node: ESTree.Node): ESTree.ArrowFunctionExpression | null {
  const block = getFunctionBlock(node);
  if (!block) return null;

  const nVars = new Set<string>();
  let hasNGet = false;
  let hasNPathHint = false;
  let transformName: string | null = null;

  walk(block, (n, parent) => {
    if (n.type === "Literal" && typeof n.value === "string") {
      if (n.value === "n" || n.value.includes("/n/")) hasNPathHint = true;
      return;
    }

    if (
      n.type === "CallExpression" &&
      n.callee.type === "MemberExpression" &&
      n.callee.property.type === "Identifier" &&
      n.callee.property.name === "get" &&
      n.arguments[0]?.type === "Literal" &&
      n.arguments[0].value === "n"
    ) {
      hasNGet = true;
      if (
        parent?.type === "VariableDeclarator" &&
        parent.id.type === "Identifier"
      ) {
        nVars.add(parent.id.name);
      }
      if (
        parent?.type === "AssignmentExpression" &&
        parent.left.type === "Identifier"
      ) {
        nVars.add(parent.left.name);
      }
      return;
    }

    if (
      transformName === null &&
      n.type === "CallExpression" &&
      n.callee.type === "Identifier" &&
      n.callee.name !== "decodeURIComponent" &&
      n.arguments.some((arg) => arg.type === "Identifier" && nVars.has(arg.name))
    ) {
      transformName = n.callee.name;
    }
  });

  if (!hasNGet || !hasNPathHint || !transformName) {
    return null;
  }
  return makeSolverFuncFromName(transformName);
}

function getFunctionBlock(node: ESTree.Node): ESTree.BlockStatement | null {
  if (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  ) {
    return node.body.type === "BlockStatement" ? node.body : null;
  }
  if (
    node.type === "ExpressionStatement" &&
    node.expression.type === "AssignmentExpression" &&
    (node.expression.right.type === "FunctionExpression" ||
      node.expression.right.type === "ArrowFunctionExpression")
  ) {
    return node.expression.right.body.type === "BlockStatement"
      ? node.expression.right.body
      : null;
  }
  if (node.type === "VariableDeclaration") {
    for (const declaration of node.declarations) {
      if (
        declaration.init?.type === "FunctionExpression" ||
        declaration.init?.type === "ArrowFunctionExpression"
      ) {
        return declaration.init.body.type === "BlockStatement"
          ? declaration.init.body
          : null;
      }
    }
  }
  return null;
}

function walk(
  node: ESTree.Node,
  cb: (node: ESTree.Node, parent: ESTree.Node | null) => void,
  parent: ESTree.Node | null = null,
) {
  cb(node, parent);
  for (const value of Object.values(node as Record<string, unknown>)) {
    if (!value) continue;
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === "object" && "type" in child) {
          walk(child as ESTree.Node, cb, node);
        }
      }
      continue;
    }
    if (typeof value === "object" && "type" in value) {
      walk(value as ESTree.Node, cb, node);
    }
  }
}