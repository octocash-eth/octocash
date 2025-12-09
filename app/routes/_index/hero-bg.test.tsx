import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { HeroBg } from "./hero-bg";

describe("HeroBg", () => {
  describe("rendering", () => {
    test("renders an SVG element", () => {
      const { container } = render(<HeroBg />);
      const svg = container.querySelector("svg");
      expect(svg).toBeInTheDocument();
    });

    test("renders with correct viewBox", () => {
      const { container } = render(<HeroBg />);
      const svg = container.querySelector("svg");
      expect(svg).toHaveAttribute("viewBox", "0 0 1728 989");
    });

    test("renders with correct dimensions", () => {
      const { container } = render(<HeroBg />);
      const svg = container.querySelector("svg");
      expect(svg).toHaveAttribute("width", "1728");
      expect(svg).toHaveAttribute("height", "989");
    });

    test("renders with preserveAspectRatio attribute", () => {
      const { container } = render(<HeroBg />);
      const svg = container.querySelector("svg");
      expect(svg).toHaveAttribute("preserveAspectRatio", "xMidYMid slice");
    });
  });

  describe("accessibility", () => {
    test("has img role", () => {
      render(<HeroBg />);
      const svg = screen.getByRole("img");
      expect(svg).toBeInTheDocument();
    });

    test("has descriptive aria-label", () => {
      render(<HeroBg />);
      const svg = screen.getByRole("img");
      expect(svg).toHaveAttribute("aria-label", "Hero background illustration with day and night theme");
    });
  });

  describe("className prop", () => {
    test("applies custom className", () => {
      const { container } = render(<HeroBg className="custom-class" />);
      const svg = container.querySelector("svg");
      expect(svg).toHaveClass("custom-class");
    });

    test("renders without className when not provided", () => {
      const { container } = render(<HeroBg />);
      const svg = container.querySelector("svg");
      expect(svg).toBeInTheDocument();
    });
  });

  describe("SVG structure", () => {
    test("contains mask element", () => {
      const { container } = render(<HeroBg />);
      const mask = container.querySelector("mask");
      expect(mask).toBeInTheDocument();
    });

    test("contains defs section", () => {
      const { container } = render(<HeroBg />);
      const defs = container.querySelector("defs");
      expect(defs).toBeInTheDocument();
    });

    test("contains filters for sun and moon", () => {
      const { container } = render(<HeroBg />);
      const filters = container.querySelectorAll("filter");
      expect(filters.length).toBeGreaterThanOrEqual(3); // sun, moonPrimary, moonSecondary
    });

    test("contains gradients", () => {
      const { container } = render(<HeroBg />);
      const linearGradients = container.querySelectorAll("linearGradient");
      const radialGradients = container.querySelectorAll("radialGradient");
      expect(linearGradients.length).toBeGreaterThan(0);
      expect(radialGradients.length).toBeGreaterThan(0);
    });

    test("contains moon group", () => {
      const { container } = render(<HeroBg />);
      const svg = container.querySelector("svg");
      const groups = svg?.querySelectorAll("g");
      expect(groups).toBeTruthy();
      expect(groups?.length).toBeGreaterThan(0);
    });

    test("contains sun group", () => {
      const { container } = render(<HeroBg />);
      const svg = container.querySelector("svg");
      const paths = svg?.querySelectorAll("path");
      expect(paths).toBeTruthy();
      expect(paths?.length).toBeGreaterThan(0);
    });

    test("contains cloud paths", () => {
      const { container } = render(<HeroBg />);
      const svg = container.querySelector("svg");
      const paths = svg?.querySelectorAll("path");
      // Should have multiple paths for clouds, mountains, sun, moon, etc.
      expect(paths?.length).toBeGreaterThan(5);
    });

    test("contains mountain paths", () => {
      const { container } = render(<HeroBg />);
      const svg = container.querySelector("svg");
      const paths = svg?.querySelectorAll("path");
      expect(paths).toBeTruthy();
      expect(paths?.length).toBeGreaterThan(0);
    });
  });

  describe("unique IDs", () => {
    test("generates unique IDs for multiple instances", () => {
      const { container: container1 } = render(<HeroBg />);
      const { container: container2 } = render(<HeroBg />);

      const mask1 = container1.querySelector("mask");
      const mask2 = container2.querySelector("mask");

      expect(mask1?.id).toBeTruthy();
      expect(mask2?.id).toBeTruthy();
      expect(mask1?.id).not.toBe(mask2?.id);
    });

    test("mask has valid id attribute", () => {
      const { container } = render(<HeroBg />);
      const mask = container.querySelector("mask");
      expect(mask?.id).toBeTruthy();
      expect(mask?.id).toMatch(/-mask$/);
    });

    test("filters have unique IDs", () => {
      const { container } = render(<HeroBg />);
      const filters = container.querySelectorAll("filter");
      const ids = Array.from(filters).map((filter) => filter.id);

      // Check all IDs are truthy
      ids.forEach((id) => {
        expect(id).toBeTruthy();
      });

      // Check all IDs are unique
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    test("gradients have unique IDs", () => {
      const { container } = render(<HeroBg />);
      const linearGradients = container.querySelectorAll("linearGradient");
      const radialGradients = container.querySelectorAll("radialGradient");
      const allGradients = [...linearGradients, ...radialGradients];
      const ids = Array.from(allGradients).map((gradient) => gradient.id);

      // Check all IDs are truthy
      ids.forEach((id) => {
        expect(id).toBeTruthy();
      });

      // Check all IDs are unique
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });
  });

  describe("CSS custom properties", () => {
    test("uses CSS custom properties for gradient colors", () => {
      const { container } = render(<HeroBg />);
      const stops = container.querySelectorAll("stop");

      // Check that some stops use CSS custom properties
      const stopsWithVars = Array.from(stops).filter((stop) => {
        const stopColor = stop.getAttribute("stopColor") || stop.getAttribute("stop-color");
        return stopColor?.includes("var(--hero-bg-gradient-");
      });

      expect(stopsWithVars.length).toBeGreaterThan(0);
    });

    test("uses CSS custom properties for moon opacity", () => {
      const { container } = render(<HeroBg />);
      const svg = container.querySelector("svg");
      const groups = svg?.querySelectorAll("g");

      // Find moon group and check for opacity custom property
      const moonGroup = Array.from(groups || []).find((g) => {
        const style = g.getAttribute("style");
        return style?.includes("--hero-moon-opacity");
      });

      expect(moonGroup).toBeTruthy();
    });

    test("uses CSS custom properties for sun opacity", () => {
      const { container } = render(<HeroBg />);
      const svg = container.querySelector("svg");
      const groups = svg?.querySelectorAll("g");

      // Find sun group and check for opacity custom property
      const sunGroup = Array.from(groups || []).find((g) => {
        const style = g.getAttribute("style");
        return style?.includes("--hero-sun-opacity");
      });

      expect(sunGroup).toBeTruthy();
    });

    test("uses CSS custom properties for cloud opacity", () => {
      const { container } = render(<HeroBg />);
      const svg = container.querySelector("svg");
      const paths = svg?.querySelectorAll("path");

      // Find cloud paths and check for opacity custom property
      const cloudPaths = Array.from(paths || []).filter((path) => {
        const style = path.getAttribute("style");
        return style?.includes("--hero-cloud-opacity-");
      });

      expect(cloudPaths.length).toBeGreaterThan(0);
    });

    test("uses CSS custom properties for transforms", () => {
      const { container } = render(<HeroBg />);
      const svg = container.querySelector("svg");
      const groups = svg?.querySelectorAll("g");

      // Find groups with transform custom properties
      const groupsWithTransforms = Array.from(groups || []).filter((g) => {
        const style = g.getAttribute("style");
        return style?.includes("--hero-moon-y") || style?.includes("--hero-sun-y");
      });

      expect(groupsWithTransforms.length).toBeGreaterThan(0);
    });
  });

  describe("transitions", () => {
    test("SVG has transition style", () => {
      const { container } = render(<HeroBg />);
      const svg = container.querySelector("svg");
      const style = svg?.getAttribute("style");
      expect(style).toContain("transition");
      expect(style).toContain("opacity");
    });

    test("animated elements have transitions", () => {
      const { container } = render(<HeroBg />);
      const svg = container.querySelector("svg");
      const groups = svg?.querySelectorAll("g");

      // Check groups that have transition styles
      const groupsWithTransitions = Array.from(groups || []).filter((g) => {
        const style = g.getAttribute("style");
        return style?.includes("transition");
      });

      expect(groupsWithTransitions.length).toBeGreaterThan(0);
    });

    test("gradient stops have transitions", () => {
      const { container } = render(<HeroBg />);
      const stops = container.querySelectorAll("stop");

      // Check if any stops have transition styles
      const stopsWithTransitions = Array.from(stops).filter((stop) => {
        const style = stop.getAttribute("style");
        return style?.includes("transition");
      });

      expect(stopsWithTransitions.length).toBeGreaterThan(0);
    });
  });

  describe("blend modes", () => {
    test("elements use screen blend mode", () => {
      const { container } = render(<HeroBg />);
      const svg = container.querySelector("svg");
      const paths = svg?.querySelectorAll("path");

      // Check for paths with screen blend mode
      const pathsWithBlendMode = Array.from(paths || []).filter((path) => {
        const style = path.getAttribute("style");
        return style?.includes("mixBlendMode") || style?.includes("mix-blend-mode");
      });

      expect(pathsWithBlendMode.length).toBeGreaterThan(0);
    });
  });

  describe("gradient definitions", () => {
    test("background gradient has multiple stops", () => {
      const { container } = render(<HeroBg />);
      const linearGradients = container.querySelectorAll("linearGradient");

      // Background gradient should have 3 stops
      const backgroundGradient = Array.from(linearGradients).find((gradient) =>
        gradient.id.endsWith("-gradient-background"),
      );

      expect(backgroundGradient).toBeTruthy();
      const stops = backgroundGradient?.querySelectorAll("stop");
      expect(stops?.length).toBe(3);
    });

    test("sun gradient is radial", () => {
      const { container } = render(<HeroBg />);
      const radialGradients = container.querySelectorAll("radialGradient");

      const sunGradient = Array.from(radialGradients).find((gradient) => gradient.id.endsWith("-gradient-sun"));

      expect(sunGradient).toBeTruthy();
    });

    test("moon gradients are radial", () => {
      const { container } = render(<HeroBg />);
      const radialGradients = container.querySelectorAll("radialGradient");

      const moonGradient = Array.from(radialGradients).find((gradient) => gradient.id.endsWith("-gradient-moon"));

      const moonInverseGradient = Array.from(radialGradients).find((gradient) =>
        gradient.id.endsWith("-gradient-moon-inverse"),
      );

      expect(moonGradient).toBeTruthy();
      expect(moonInverseGradient).toBeTruthy();
    });

    test("cloud gradients use pink to purple colors", () => {
      const { container } = render(<HeroBg />);
      const linearGradients = container.querySelectorAll("linearGradient");

      const cloudGradients = Array.from(linearGradients).filter(
        (gradient) =>
          gradient.id.includes("-gradient-low-cloud") ||
          gradient.id.includes("-gradient-high-cloud") ||
          gradient.id.includes("-gradient-horizon"),
      );

      expect(cloudGradients.length).toBeGreaterThan(0);

      // Check gradient stops have correct colors
      cloudGradients.forEach((gradient) => {
        const stops = gradient.querySelectorAll("stop");
        expect(stops.length).toBe(2);

        const firstStop = stops[0];
        const lastStop = stops[1];

        expect(firstStop.getAttribute("stopColor") || firstStop.getAttribute("stop-color")).toBe("#ff719f");
        expect(lastStop.getAttribute("stopColor") || lastStop.getAttribute("stop-color")).toBe("#975fff");
      });
    });
  });

  describe("filter effects", () => {
    test("sun filter has gaussian blur", () => {
      const { container } = render(<HeroBg />);
      const filters = container.querySelectorAll("filter");

      const sunFilter = Array.from(filters).find((filter) => filter.id.endsWith("-filter-sun"));

      expect(sunFilter).toBeTruthy();

      const gaussianBlur = sunFilter?.querySelector("feGaussianBlur");
      expect(gaussianBlur).toBeTruthy();
      expect(gaussianBlur?.getAttribute("stdDeviation")).toBe("10");
    });

    test("moon filters have gaussian blur", () => {
      const { container } = render(<HeroBg />);
      const filters = container.querySelectorAll("filter");

      const moonFilters = Array.from(filters).filter(
        (filter) => filter.id.endsWith("-filter-moon-primary") || filter.id.endsWith("-filter-moon-secondary"),
      );

      expect(moonFilters.length).toBe(2);

      moonFilters.forEach((filter) => {
        const gaussianBlur = filter.querySelector("feGaussianBlur");
        expect(gaussianBlur).toBeTruthy();
        expect(gaussianBlur?.getAttribute("stdDeviation")).toBe("10");
      });
    });
  });
});
