"use client";

import { Button, Code, Heading, HStack, Stack, Text } from "@chakra-ui/react";
import NextLink from "next/link";
import { useEffect } from "react";
import { SiteShell } from "@/components/billing/site-shell";

export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <SiteShell>
      <Stack gap="4" align="center" textAlign="center" py={{ base: "8", md: "16" }}>
        <Heading as="h1" size="2xl">
          Something went wrong
        </Heading>
        <Text color="fg.muted" maxW="md">
          An unexpected error interrupted this page. Your subscription is safe — billing state lives in Stripe and is
          synced by webhooks.
        </Text>
        {error.digest && (
          <Text textStyle="xs" color="fg.subtle">
            Reference <Code size="sm">{error.digest}</Code>
          </Text>
        )}
        <HStack gap="3">
          <Button colorPalette="purple" onClick={() => retry()}>
            Try again
          </Button>
          <Button asChild variant="outline">
            <NextLink href="/">Home</NextLink>
          </Button>
        </HStack>
      </Stack>
    </SiteShell>
  );
}
