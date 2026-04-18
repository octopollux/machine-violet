import React, { useState, useCallback } from "react";
import { useInput, Text, Box, useWindowSize } from "ink";
import type { ResolvedTheme } from "../tui/themes/types.js";
import { ThemedHorizontalBorder, ThemedSideFrame, TerminalTooSmall } from "../tui/components/index.js";
import { MIN_COLUMNS, MIN_ROWS } from "../tui/responsive.js";
import { themeColor } from "../tui/themes/color-resolve.js";
import { InlineTextInput } from "../tui/components/InlineTextInput.js";
import type { ValidatedPdf } from "../content/index.js";
import type { AvailableSystem } from "../config/systems.js";

type Step = "pick_system" | "name_other" | "drop" | "confirm" | "submitting" | "done" | "error";

export interface AddContentPhaseProps {
  theme: ResolvedTheme;
  /** Available game systems (known + discovered). */
  systems: AvailableSystem[];
  /** Called when user confirms submission. Parent handles the actual pipeline. */
  onSubmit: (systemSlug: string, systemName: string, pdfs: ValidatedPdf[]) => void;
  /** Called when user cancels (Escape from pick step). */
  onCancel: () => void;
  /** Validate a file path as a PDF — returns info or throws. */
  validatePdf: (path: string) => Promise<ValidatedPdf>;
  /** External error message (e.g. from pipeline failure). */
  errorMsg?: string | null;
  /** External status message (e.g. "Submitting batch..."). */
  statusMsg?: string | null;
}

export function AddContentPhase({
  theme,
  systems,
  onSubmit,
  onCancel,
  validatePdf,
  errorMsg: externalError,
  statusMsg,
}: AddContentPhaseProps) {
  const { columns: cols, rows: termRows } = useWindowSize();
  const [step, setStep] = useState<Step>("pick_system");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [systemSlug, setSystemSlug] = useState("");
  const [systemName, setSystemName] = useState("");
  const [pdfs, setPdfs] = useState<ValidatedPdf[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);

  const errorMsg = localError || externalError || null;

  // Build picker options: known systems + "Other"
  const pickerOptions = [...systems, { slug: "__other__", name: "Other (enter name)", bundled: false, hasRuleCard: false, processed: false }];

  // --- System picker ---
  const handlePickerSelect = useCallback(() => {
    const chosen = pickerOptions[selectedIndex];
    if (chosen.slug === "__other__") {
      setStep("name_other");
      setLocalError(null);
    } else {
      setSystemSlug(chosen.slug);
      setSystemName(chosen.name);
      setLocalError(null);
      setStep("drop");
    }
  }, [selectedIndex, pickerOptions]);

  // --- Custom name input ---
  const handleNameSubmit = useCallback((value: string) => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      setLocalError("System name cannot be empty.");
      return;
    }
    // Slugify the custom name (must match slugify() in job-manager.ts)
    const slug = trimmed
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    setSystemSlug(slug);
    setSystemName(trimmed);
    setLocalError(null);
    setStep("drop");
  }, []);

  // --- PDF drop input ---
  const handleDropSubmit = useCallback(async (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      // Empty submit on drop step = done adding files
      if (pdfs.length === 0) {
        setLocalError("Add at least one PDF before continuing.");
        return;
      }
      setLocalError(null);
      setStep("confirm");
      return;
    }

    // Parse paths — handle quoted paths and multiple space-separated paths.
    // Windows drag-and-drop often wraps paths in quotes.
    const paths = parsePaths(trimmed);

    setValidating(true);
    setLocalError(null);

    for (const filePath of paths) {
      try {
        const info = await validatePdf(filePath);
        // Avoid duplicates by base name
        setPdfs((prev) => {
          if (prev.some((p) => p.baseName === info.baseName)) return prev;
          return [...prev, info];
        });
      } catch (e) {
        setLocalError(e instanceof Error ? e.message : `Invalid PDF: ${filePath}`);
      }
    }
    setValidating(false);
  }, [pdfs.length, validatePdf]);

  // --- Confirm step ---
  const handleConfirm = useCallback(() => {
    setStep("submitting");
    onSubmit(systemSlug, systemName, pdfs);
  }, [systemSlug, systemName, pdfs, onSubmit]);

  // --- Key handling ---
  useInput((input, key) => {
    if (step === "pick_system") {
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.upArrow) {
        setSelectedIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((i) => Math.min(pickerOptions.length - 1, i + 1));
        return;
      }
      if (key.return) {
        handlePickerSelect();
        return;
      }
    }
    if (step === "name_other" && key.escape) {
      setStep("pick_system");
      return;
    }
    if (step === "drop" && key.escape) {
      if (pdfs.length === 0) {
        setStep("pick_system");
      } else {
        setStep("confirm");
      }
      return;
    }
    if (step === "confirm") {
      if (key.return || input === "y" || input === "Y") {
        handleConfirm();
        return;
      }
      if (key.escape || input === "n" || input === "N") {
        setStep("drop");
        return;
      }
    }
    if (step === "error" && (key.return || key.escape)) {
      onCancel();
    }
  }, { isActive: step !== "submitting" && step !== "done" });

  // --- Terminal too small ---
  if (cols < MIN_COLUMNS || termRows < MIN_ROWS) {
    return <TerminalTooSmall columns={cols} rows={termRows} />;
  }

  const borderColor = themeColor(theme, "border");
  const dimColor = themeColor(theme, "separator") ?? "#666666";
  const sideWidth = theme.asset.components.edge_left.width;
  const topHeight = theme.asset.height;
  const contentWidth = cols - sideWidth * 2;
  const contentHeight = termRows - topHeight * 2;

  // --- Build content lines ---
  const lines: React.ReactNode[] = [];

  lines.push(
    <Text key="title" bold color={borderColor}>Add Content</Text>,
  );
  lines.push(<Text key="sp0"> </Text>);

  if (step === "pick_system") {
    lines.push(
      <Text key="prompt">Select a game system:</Text>,
    );
    lines.push(<Text key="sp1"> </Text>);

    for (const [i, opt] of pickerOptions.entries()) {
      const isSelected = i === selectedIndex;
      const prefix = isSelected ? "> " : "  ";
      const processedMark = "processed" in opt && opt.processed ? " \u2713" : "";
      lines.push(
        <Text key={`opt-${opt.slug}`}>
          <Text color={isSelected ? borderColor : undefined} bold={isSelected}>
            {prefix}{opt.name}
          </Text>
          {processedMark && <Text color="green">{processedMark}</Text>}
        </Text>,
      );
    }

    lines.push(<Text key="sp2"> </Text>);
    lines.push(
      <Text key="hint" color={dimColor}>
        Arrow keys to select, Enter to confirm, Esc to go back
      </Text>,
    );
  }

  if (step === "name_other") {
    lines.push(
      <Text key="prompt">Name this system:</Text>,
    );
    lines.push(
      <Box key="input" height={1}>
        <Text color={borderColor}>{"> "}</Text>
        <InlineTextInput
          onSubmit={handleNameSubmit}
          availableWidth={Math.max(20, contentWidth - 10)}
        />
      </Box>,
    );
    lines.push(<Text key="sp1"> </Text>);
    lines.push(
      <Text key="hint" color={dimColor}>
        e.g. "Cairn", "My Homebrew System"
      </Text>,
    );
    lines.push(
      <Text key="escape" color={dimColor}>Esc to go back</Text>,
    );
  }

  if (step === "drop" || step === "confirm") {
    lines.push(
      <Text key="sys">
        <Text color={borderColor}>System: </Text>
        <Text bold>{systemName}</Text>
      </Text>,
    );
    lines.push(<Text key="sp1"> </Text>);

    if (pdfs.length > 0) {
      for (const pdf of pdfs) {
        lines.push(
          <Text key={`pdf-${pdf.baseName}`}>
            <Text color="green">  {"  \u2713"} </Text>
            <Text>{pdf.baseName}.pdf</Text>
            <Text color={dimColor}>{`  (${pdf.pageCount} pp)`}</Text>
          </Text>,
        );
      }
      lines.push(<Text key="sp2"> </Text>);
    }

    if (step === "drop") {
      lines.push(
        <Text key="drop-prompt">
          {validating ? "Validating..." : "Drop PDF files here (Enter when done):"}
        </Text>,
      );
      lines.push(
        <Box key="drop-input" height={1}>
          <Text color={borderColor}>{"> "}</Text>
          <InlineTextInput
            key={pdfs.length}
            isDisabled={validating}
            onSubmit={handleDropSubmit}
            availableWidth={Math.max(20, contentWidth - 10)}
          />
        </Box>,
      );
      lines.push(<Text key="sp3"> </Text>);
      lines.push(
        <Text key="drop-hint" color={dimColor}>
          Drag-and-drop files or paste paths. Press Enter with no input when done.
        </Text>,
      );
    }

    if (step === "confirm") {
      lines.push(
        <Text key="confirm-prompt">
          Submit {pdfs.length} PDF{pdfs.length !== 1 ? "s" : ""} for processing? <Text color={dimColor}>(y/n)</Text>
        </Text>,
      );
    }
  }

  if (step === "submitting") {
    lines.push(
      <Text key="sys">
        <Text color={borderColor}>System: </Text>
        <Text bold>{systemName}</Text>
      </Text>,
    );
    lines.push(<Text key="sp1"> </Text>);

    for (const pdf of pdfs) {
      lines.push(
        <Text key={`pdf-${pdf.baseName}`}>
          <Text color="green">  {"  \u2713"} </Text>
          <Text>{pdf.baseName}.pdf</Text>
          <Text color={dimColor}>{`  (${pdf.pageCount} pp)`}</Text>
        </Text>,
      );
    }
    lines.push(<Text key="sp2"> </Text>);
    lines.push(
      <Text key="status">{statusMsg ?? "Processing..."}</Text>,
    );
  }

  if (errorMsg) {
    lines.push(
      <Text key="error" color="red">{errorMsg}</Text>,
    );
  }

  // Center vertically
  const menuHeight = lines.length;
  const topPad = Math.max(0, Math.floor((contentHeight - menuHeight) / 2));
  const bottomPad = Math.max(0, contentHeight - menuHeight - topPad);

  return (
    <Box flexDirection="column" width={cols} height={termRows}>
      <ThemedHorizontalBorder
        theme={theme}
        width={cols}
        position="top"
        centerText="Machine Violet"
      />

      <Box flexDirection="row" height={contentHeight}>
        <ThemedSideFrame theme={theme} side="left" height={contentHeight} />
        <Box flexDirection="column" width={contentWidth} alignItems="center">
          {topPad > 0 && <Box height={topPad} />}
          <Box flexDirection="column" alignItems="flex-start">
            {lines}
          </Box>
          {bottomPad > 0 && <Box height={bottomPad} />}
        </Box>
        <ThemedSideFrame theme={theme} side="right" height={contentHeight} />
      </Box>

      <ThemedHorizontalBorder
        theme={theme}
        width={cols}
        position="bottom"
      />
    </Box>
  );
}

/**
 * Parse drag-and-dropped file paths.
 * Handles: quoted paths, multiple paths separated by spaces,
 * Windows-style backslash paths.
 */
export function parsePaths(input: string): string[] {
  const paths: string[] = [];
  let remaining = input.trim();

  while (remaining.length > 0) {
    if (remaining.startsWith('"')) {
      // Quoted path — find closing quote
      const end = remaining.indexOf('"', 1);
      if (end === -1) {
        // No closing quote — take rest as path
        paths.push(remaining.slice(1).trim());
        break;
      }
      paths.push(remaining.slice(1, end));
      remaining = remaining.slice(end + 1).trim();
    } else if (remaining.startsWith("'")) {
      const end = remaining.indexOf("'", 1);
      if (end === -1) {
        paths.push(remaining.slice(1).trim());
        break;
      }
      paths.push(remaining.slice(1, end));
      remaining = remaining.slice(end + 1).trim();
    } else {
      // Unquoted — take until next space (but handle drive letters on Windows)
      // Windows paths like C:\foo\bar.pdf — if we see X:\ pattern, take until next space after .pdf
      const spaceIdx = remaining.indexOf(" ");
      if (spaceIdx === -1) {
        paths.push(remaining);
        break;
      }
      paths.push(remaining.slice(0, spaceIdx));
      remaining = remaining.slice(spaceIdx).trim();
    }
  }

  return paths.filter((p) => p.length > 0);
}
