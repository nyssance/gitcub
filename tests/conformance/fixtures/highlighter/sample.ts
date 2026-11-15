declare module "x" { export function f(a: number): string }
abstract class Base<T> implements Iterable<T> { abstract [Symbol.iterator](): Iterator<T>; protected readonly tag = "base" as const }
export default function g<T>(x: T | null): asserts x is T { if (x == null) throw new Error(`bad ${x}`) }
