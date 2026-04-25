import chalk from "chalk";
import { Vec3 } from "vec3";

Vec3.prototype.toString = function() {
	return `${ Intl.NumberFormat().format(this.x) } ${ chalk.gray("/") } ${ Intl.NumberFormat().format(this.y) } ${ chalk.gray("/") } ${ Intl.NumberFormat().format(this.z) }`;
};
