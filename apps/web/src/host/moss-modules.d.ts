// Vendored moss modules the host imports through vite's @moss-desktop alias. Declared here so apps/web's
// typecheck stops at the vendor boundary: moss's own tsconfig checks moss upstream, and the vendor tree stays
// byte-identical (A§2.1).
declare module '@moss-desktop/renderer/editor/plugins/code-block/prism-setup' {}

declare module '@moss-desktop/renderer/App' {
  import type { ComponentType } from 'react';
  const App: ComponentType;
  export default App;
}

declare module '@moss-desktop/renderer/error-analytics' {
  export function installRendererErrorAnalytics(): void;
}

declare module '@moss-desktop/renderer/PdfExportApp' {
  import type { ComponentType } from 'react';
  const PdfExportApp: ComponentType;
  export default PdfExportApp;
}

// moss's DS primitives the host surfaces compose (T0.10), typed as moss declares them.
declare module '@moss/shared/components/ui/button' {
  import type { ButtonHTMLAttributes, ForwardRefExoticComponent, RefAttributes } from 'react';
  export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: 'default' | 'danger' | 'secondary' | 'outline' | 'ghost' | 'link' | 'stop' | null;
    size?: 'default' | 'sm' | 'lg' | 'icon' | null;
    asChild?: boolean;
  }
  export const Button: ForwardRefExoticComponent<ButtonProps & RefAttributes<HTMLButtonElement>>;
}

declare module '@moss/shared/components/ui/card' {
  import type { ForwardRefExoticComponent, HTMLAttributes, RefAttributes } from 'react';
  export const Card: ForwardRefExoticComponent<HTMLAttributes<HTMLDivElement> & RefAttributes<HTMLDivElement>>;
}

declare module '@moss/shared/components/ui/input' {
  import type { ComponentProps, ForwardRefExoticComponent } from 'react';
  export const Input: ForwardRefExoticComponent<ComponentProps<'input'>>;
}

declare module '@moss/shared/components/ui/label' {
  import type { ForwardRefExoticComponent, LabelHTMLAttributes, RefAttributes } from 'react';
  export const Label: ForwardRefExoticComponent<LabelHTMLAttributes<HTMLLabelElement> & RefAttributes<HTMLLabelElement>>;
}
