import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { glimRows, moodLine } from '../glim.js';
import { theme } from '../theme.js';
import { fit } from '../text.js';
import { VERSION } from '../version.js';
import { Row } from './parts.jsx';

export const GLIM_WIDTH = 16;
export const WELCOME_HEIGHT = 7;

/** Glim in pixels. While a query runs ("look") Glim glances from side to side. */
export function Glim({ mood }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (mood !== 'look') return;
    const t = setInterval(() => setTick((n) => n + 1), 450);
    return () => clearInterval(t);
  }, [mood]);
  const shown = mood === 'look' && tick % 2 ? 'idle' : mood;
  return glimRows(shown).map((segs, i) => <Row key={i} pointer={false} width={GLIM_WIDTH} segments={segs} />);
}

/** The box shown when Trawl starts, like Claude Code's welcome. Esc or the first query clears it. */
export function Welcome({ mood, session, width }) {
  const textW = Math.max(10, width - GLIM_WIDTH - 7);
  return (
    <Box borderStyle="round" borderColor={theme.accent} width={width} height={WELCOME_HEIGHT} paddingX={1}>
      <Box flexDirection="column" width={GLIM_WIDTH}>
        <Glim mood={mood} />
      </Box>
      <Box flexDirection="column" marginLeft={2} width={textW}>
        <Text wrap="truncate">
          <Text bold>Welcome to Trawl</Text>
          <Text color={theme.dim}>{`  v${VERSION}`}</Text>
        </Text>
        <Text color={theme.dim} wrap="truncate">
          {fit(`Glim the anglerfish here. ${moodLine(mood, session)}`, textW).trimEnd()}
        </Text>
        <Text> </Text>
        <Text color={theme.dim} wrap="truncate">
          {fit('/ commands · ! SQL · ? shortcuts · esc to put this away', textW).trimEnd()}
        </Text>
      </Box>
    </Box>
  );
}
