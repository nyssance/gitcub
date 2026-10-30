import { AutocompletingTextInput } from "./autocompleting-text-input"
export class AutocompletingTextArea<AutocompleteItemType extends object = object> extends AutocompletingTextInput<
  HTMLTextAreaElement,
  AutocompleteItemType
> {
  protected getElementTagName(): "textarea" | "input" {
    return "textarea"
  }
}
export class AutocompletingInput<AutocompleteItemType extends object = object> extends AutocompletingTextInput<
  HTMLInputElement,
  AutocompleteItemType
> {
  protected getElementTagName(): "textarea" | "input" {
    return "input"
  }
}
