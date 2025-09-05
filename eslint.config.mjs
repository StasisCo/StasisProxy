import eslint from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import tseslint from "typescript-eslint";

export default tseslint.config(

	// Ignores
	{
		ignores: [
			"node_modules/",
			"src/generated/"
		]
	},

	// Extends
	eslint.configs.recommended,
	...tseslint.configs.recommended,

	// Plugins & Rules
	{
		plugins: {
			"@stylistic": stylistic
		},

		languageOptions: {
			ecmaVersion: 12,
			sourceType: "module"
		},

		rules: {

			// This rule enforces a consistent indentation style.
			"@stylistic/indent": [ "warn", "tab" ],
			"indent": "off",

			// This rule disallows the use of `case` declarations.
			"no-case-declarations": "off",

			// This rule enforces consistent spacing inside braces of array literals.
			"array-bracket-spacing": [ "warn", "always" ],

			// This rule enforces consistent use of double quotes.
			"quotes": [ "warn", "double" ],

			// This rule enforces consistent spacing inside braces of object literals.
			"object-curly-spacing": [ "warn", "always", { objectsInObjects: false, arraysInObjects: false } ],

			// This rule enforces consistent use of semicolons.
			"semi": "warn",

			// This rule enforces consistent use of trailing commas in object literals, arrays, and function parameters.
			"comma-dangle": [ "warn", "never" ],

			// This rule enforces consistent line breaks inside array brackets.
			"array-bracket-newline": [ "warn", "consistent" ],

			// This rule enforces consistent spacing after the comma.
			"comma-spacing": "warn",

			// This rule enforces consistent spacing inside template literals.
			"template-curly-spacing": [ "warn", "always" ],

			// This rule enforces consistent the use of the strict equality operator.
			"eqeqeq": [ "warn", "always" ],

			// This rule enforces consistent spacing before and after semicolons.
			"semi-spacing": "warn",

			// This rule enforces a maximum number of statements per line.
			"max-statements-per-line": "warn",

			// This rule enforces consistent spacing inside parentheses.
			"space-in-parens": "warn",

			// This rule enforces consistent spacing inside braces.
			"space-infix-ops": "warn",

			// This rule enforces consistent spacing before and after keywords.
			"keyword-spacing": "warn",

			// This rule enforces consistent spacing before and after function parentheses.
			"space-before-function-paren": [ "warn", "never" ],

			// This rule enforces consistent spacing between the key and the value in object properties.
			"key-spacing": "warn",

			// This rule enforces no trailing spaces at the end of lines.
			"no-trailing-spaces": [ "warn", { ignoreComments: true, skipBlankLines: true } ],

			// This rule enforces consistent use of parentheses around arrow function parameters.
			"arrow-parens": [ "warn", "as-needed" ],

			// This rule enforces consistent spacing before and after the arrow in arrow functions.
			"func-call-spacing": "warn",

			// This rule enforces consistent use of tabs and spaces.
			"no-mixed-spaces-and-tabs": [ "warn" ],

			// This rule enforces consistent use of line breaks.
			"no-multiple-empty-lines": [ "warn", { max: 1, maxBOF: 0 } ],

			// This rule enforces consistent use of spaces in regular expressions.
			"no-regex-spaces": "warn",

			// This rule enforces consistent use of spaces around operators.
			"no-multi-spaces": "warn",

			// This rule enforces consistent use of spaces around unary operators.
			"space-unary-ops": "warn",

			// This rule enforces consistent use of spaces around comments.
			"lines-around-comment": [ "warn", { beforeBlockComment: true, beforeLineComment: true, afterBlockComment: false, afterLineComment: false, allowBlockStart: false, allowBlockEnd: false } ],

			// This rule enforces consistent use of spaces around property names.
			"no-whitespace-before-property": "warn",

			// This rule enforces consistent spacing in comments.
			"spaced-comment": [ "warn", "always", { line: { markers: [ "/" ], exceptions: [ "-", "+" ]}, block: { markers: [ "!" ], exceptions: [ "*" ], balanced: true }} ],

			// This rule enforces consistent spacing inside computed properties.
			"computed-property-spacing": "warn",

			// This rule enforces consistent spacing inside array literals.
			"rest-spread-spacing": "warn",

			// This rule enforces function call argument newline.
			"function-call-argument-newline": [ "warn", "consistent" ],

			// This rule aims to enforce a consistent location for single-line statements.
			"nonblock-statement-body-position": "warn",

			// This rule enforces consistent spacing before and after blocks.
			"space-before-blocks": "warn",

			// This rule disallows duplicate arguments in function definitions.
			"no-dupe-args": "warn",

			// This rule disallows duplicate conditions in if-else-if chains.
			"no-dupe-else-if": "warn",

			// This rule enforces consistent brace style for blocks.
			"brace-style": "warn",

			// This rule disallows the use of undefined variables.
			"no-undef": "off",

			// This rule disallows the use of `Object.prototype` built-in methods directly on objects.
			"no-prototype-builtins": "off",

			// This rule disallows unused variables.
			"no-unused-vars": "off",

			// This rule disallows fall-through of case statements.
			"no-fallthrough": "off",

			// This rule disallows empty block statements.
			"no-empty": "off",

			// This rule highlights unused variables. (Typescript does this better)
			"@typescript-eslint/no-unused-vars": "off"
		}
	}
);
