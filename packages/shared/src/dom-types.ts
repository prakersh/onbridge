export interface DomNode {
  role: string;
  name?: string;
  ref?: number;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  placeholder?: string;
  href?: string;
  type?: string;
  expanded?: boolean;
  selected?: boolean;
  level?: number;
  children?: DomNode[];
}

export interface ScrollState {
  percent: number;
  pagesAbove: number;
  pagesBelow: number;
}

export interface PageSnapshot {
  url: string;
  title: string;
  tree: DomNode[];
  scroll: ScrollState;
  refCount: number;
}

export interface FindResult {
  ref: number;
  role: string;
  name: string;
  context: string;
}
