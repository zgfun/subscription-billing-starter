"use client";

import { Button, Stack, Text, type ButtonProps } from "@chakra-ui/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { startDemo } from "./api";

export function DemoButton({ next = "/pricing", children = "Try the demo", ...props }: ButtonProps & { next?: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Stack gap="2" align={{ base: "stretch", sm: "flex-start" }}>
      <Button
        colorPalette="purple"
        size="lg"
        loading={loading}
        loadingText="Creating demo user…"
        onClick={async () => {
          setLoading(true);
          setError(null);
          try {
            await startDemo();
            router.push(next);
            router.refresh();
          } catch (e) {
            setError(e instanceof Error ? e.message : "Could not start the demo");
            setLoading(false);
          }
        }}
        {...props}
      >
        {children}
      </Button>
      {error && (
        <Text textStyle="sm" color="fg.error" role="alert">
          {error}
        </Text>
      )}
    </Stack>
  );
}
