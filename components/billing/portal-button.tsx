"use client";

import { Button, type ButtonProps } from "@chakra-ui/react";
import { useState } from "react";
import { openPortal } from "./api";

export function PortalButton({ children = "Manage billing", ...props }: ButtonProps) {
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <Button
      loading={loading}
      loadingText="Opening portal…"
      onClick={async () => {
        setLoading(true);
        setFailed(false);
        try {
          await openPortal();
        } catch {
          setFailed(true);
          setLoading(false);
        }
      }}
      {...props}
    >
      {failed ? "Portal unavailable — retry" : children}
    </Button>
  );
}
