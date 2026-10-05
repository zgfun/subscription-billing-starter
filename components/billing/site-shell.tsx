"use client";

import { Box, Button, Container, Flex, HStack, Link, Text } from "@chakra-ui/react";
import NextLink from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { logout } from "./api";
import { ColorModeToggle } from "./color-mode-toggle";
import { InkwellMark } from "./logo";
import { TestModeBanner } from "./test-mode-banner";

const NAV = [
  { href: "/pricing", label: "Pricing" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/admin", label: "Ledger" },
];

export function SiteShell({ children, signedIn = false }: { children: ReactNode; signedIn?: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);
  return (
    <Flex direction="column" minH="100dvh" bg="bg">
      <TestModeBanner />
      <Box as="header" borderBottomWidth="1px" bg="bg/80" backdropFilter="blur(8px)" position="sticky" top="0" zIndex="sticky">
        <Container maxW="5xl" px={{ base: "4", md: "6" }}>
          <Flex h="14" align="center" justify="space-between" gap="2">
            <Link asChild fontWeight="semibold" fontSize="lg" _hover={{ textDecoration: "none" }} gap="2">
              <NextLink href="/" aria-label="Inkwell home">
                <InkwellMark />
                <Box as="span" display={signedIn ? { base: "none", sm: "inline" } : undefined}>
                  Inkwell
                </Box>
              </NextLink>
            </Link>
            <HStack gap={{ base: "0", sm: "1" }}>
              {NAV.map((item) => {
                const current = pathname === item.href || pathname.startsWith(`${item.href}/`);
                return (
                  <Button
                    key={item.href}
                    asChild
                    size="sm"
                    variant={current ? "subtle" : "ghost"}
                    px={{ base: "2", sm: "3" }}
                    display={item.href === "/dashboard" && !signedIn ? { base: "none", sm: "inline-flex" } : undefined}
                  >
                    <NextLink href={item.href} aria-current={current ? "page" : undefined}>
                      {item.label}
                    </NextLink>
                  </Button>
                );
              })}
              {signedIn && (
                <Button
                  size="sm"
                  variant="ghost"
                  px={{ base: "2", sm: "3" }}
                  loading={leaving}
                  onClick={async () => {
                    setLeaving(true);
                    await logout();
                    router.push("/");
                    router.refresh();
                    setLeaving(false);
                  }}
                >
                  Log out
                </Button>
              )}
              <ColorModeToggle />
            </HStack>
          </Flex>
        </Container>
      </Box>
      <Box as="main" flex="1" py={{ base: "8", md: "12" }}>
        <Container maxW="5xl" px={{ base: "4", md: "6" }}>
          {children}
        </Container>
      </Box>
      <Box as="footer" borderTopWidth="1px" py="6">
        <Container maxW="5xl" px={{ base: "4", md: "6" }}>
          <Text textStyle="xs" color="fg.muted">
            Inkwell is a fictional writing app — a portfolio demo of Stripe subscription billing with Next.js. Stripe test
            mode only.
          </Text>
        </Container>
      </Box>
    </Flex>
  );
}
