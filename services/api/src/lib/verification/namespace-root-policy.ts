import { badRequestError } from "../errors"

// Platform route and control-plane labels cannot be attached as community roots, even when an
// external HNS or Spaces namespace with the same label is valid and controlled by the caller.
export const RESERVED_NAMESPACE_ROOT_LABELS = new Set([
  "u",
  "g",
  "api",
  "auth",
  "settings",
  "admin",
])

export function assertNamespaceRootLabelIsAttachable(normalizedRootLabel: string): void {
  if (RESERVED_NAMESPACE_ROOT_LABELS.has(normalizedRootLabel)) {
    throw badRequestError("Namespace root label is reserved by Pirate")
  }
}
