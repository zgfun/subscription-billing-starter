import { Button, Code, Heading, Stack, Text } from "@chakra-ui/react";
import NextLink from "next/link";
import { SiteShell } from "@/components/billing/site-shell";

export default function NotFound() {
  return (
    <SiteShell>
      <Stack gap="4" align="center" textAlign="center" py={{ base: "8", md: "16" }}>
        <Code size="lg" variant="surface">
          404
        </Code>
        <Heading as="h1" size="2xl">
          This page is still a blank draft
        </Heading>
        <Text color="fg.muted" maxW="md">
          We couldn&apos;t find what you were looking for. It may have been moved, or it never existed.
        </Text>
        <Button asChild colorPalette="purple">
          <NextLink href="/">Back to Inkwell</NextLink>
        </Button>
      </Stack>
    </SiteShell>
  );
}
