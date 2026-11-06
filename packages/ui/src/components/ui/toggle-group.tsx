import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";
import type * as React from "react";
import { cn } from "../../lib/utils.ts";

export function ToggleGroup({
  className,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root>) {
  return (
    <ToggleGroupPrimitive.Root
      className={cn("inline-flex items-center rounded-md border border-border p-0.5", className)}
      {...props}
    />
  );
}

export function ToggleGroupItem({
  className,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  return (
    <ToggleGroupPrimitive.Item
      className={cn(
        "h-6 rounded-sm px-2 text-xs font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=on]:bg-muted data-[state=on]:text-foreground",
        className,
      )}
      {...props}
    />
  );
}
