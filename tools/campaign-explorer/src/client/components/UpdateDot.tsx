interface UpdateDotProps {
  visible: boolean;
}

export function UpdateDot({ visible }: UpdateDotProps) {
  if (!visible) return null;
  return <span className="update-dot" />;
}
