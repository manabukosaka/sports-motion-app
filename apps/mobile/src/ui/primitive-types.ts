import type { ReactNode } from "react";

export interface ActionProps {
  children: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "chip" | "ghost";
  selected?: boolean;
  disabled?: boolean;
}

export interface ScrubberProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
}

export interface LoupeProps {
  width: number;
  height: number;
  x: number;
  y: number;
  zoom: number;
  frameWidth: number;
  frameHeight: number;
  focusX: number;
  focusY: number;
  points: readonly { id: string; left: number; top: number; color?: string }[];
}

export interface ChoiceCardProps {
  label: string;
  description: string;
  icon: string;
  selected: boolean;
  onPress: () => void;
}

export interface StepperProps {
  steps: readonly string[];
  active: number;
  visited: ReadonlySet<number>;
  onSelect: (index: number) => void;
}

export interface FooterProps {
  onBack?: () => void;
  children?: ReactNode;
}

export interface GuideProps {
  badge: string;
  children: string;
  tone?: "default" | "warning" | "success";
}

export interface StatProps {
  label: string;
  value: string;
  unit: string;
  trend?: string;
}
