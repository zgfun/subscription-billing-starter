"use client";

import { Box, Code, Text } from "@chakra-ui/react";

export function TestModeBanner() {
  return (
    <Box
      role="note"
      aria-label="Test mode"
      bg="orange.subtle"
      color="orange.fg"
      borderBottomWidth="1px"
      borderColor="orange.muted"
      px="4"
      py="2"
      textAlign="center"
    >
      <Text textStyle="sm" fontWeight="medium">
        <Box as="span" fontWeight="bold" letterSpacing="wide" textTransform="uppercase" mr="2">
          Test mode
        </Box>
        — use card{" "}
        <Code variant="surface" colorPalette="orange" size="sm" whiteSpace="nowrap">
          4242 4242 4242 4242
        </Code>
        , any future date, any CVC. No real money moves.
      </Text>
    </Box>
  );
}
