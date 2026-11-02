import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

/** 合并 class：后者覆盖前者的同类 Tailwind 工具类。 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
