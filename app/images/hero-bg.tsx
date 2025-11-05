import { useId } from "react";

type HeroBgProps = {
  className?: string;
};

export function HeroBg({ className }: HeroBgProps) {
  const uniqueId = useId();

  const ids = {
    mask: `${uniqueId}-mask`,
    filters: {
      sun: `${uniqueId}-filter-sun`,
      moonPrimary: `${uniqueId}-filter-moon-primary`,
      moonSecondary: `${uniqueId}-filter-moon-secondary`,
    },
    gradients: {
      background: `${uniqueId}-gradient-background`,
      cloud1: `${uniqueId}-gradient-low-cloud`,
      cloud2: `${uniqueId}-gradient-high-cloud`,
      cloud3: `${uniqueId}-gradient-horizon`,
      rightMountain: `${uniqueId}-gradient-right-wave`,
      leftMountain: `${uniqueId}-gradient-left-wave`,
      sun: `${uniqueId}-gradient-sun`,
      moon: `${uniqueId}-gradient-moon`,
      moonInverse: `${uniqueId}-gradient-moon-inverse`,
    },
  } as const;

  // Get gradient colors from CSS custom properties
  const getGradientColor = (index: number) => `var(--hero-bg-gradient-${index})`;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="1728"
      height="989"
      fill="none"
      aria-label="Hero background illustration with day and night theme"
      role="img"
      className={className}
      preserveAspectRatio="xMidYMid slice"
      style={{
        transition: "opacity 0.5s ease-in-out",
      }}
      viewBox="0 0 1728 989"
    >
      <mask
        id={ids.mask}
        style={{ maskType: "alpha" }}
        maskUnits="userSpaceOnUse"
        x="0"
        y="0"
        width="1728"
        height="989"
      >
        <path fill="#d9d9d9" d="M0 0h1728v989H0z" />
      </mask>
      <g mask={`url(#${ids.mask})`}>
        <path fill={`url(#${ids.gradients.background})`} d="M1728 0H0v989h1728z" />
        <g
          style={{
            opacity: "var(--hero-moon-opacity)",
            transform: `translateY(var(--hero-moon-y))`,
            transformOrigin: "50% 50%",
            transformBox: "fill-box",
            transition: "opacity 0.5s ease-in-out, transform 0.5s ease-in-out",
          }}
        >
          <g opacity=".3">
            <path
              fill={`url(#${ids.gradients.moon})`}
              d="M535-4.5C535-189.245 684.572-339 869.09-339c184.52 0 334.09 149.755 334.09 334.5S1053.61 330 869.09 330C684.572 330 535 180.224 535-4.5"
              style={{ mixBlendMode: "screen" }}
            />
            <g filter={`url(#${ids.filters.moonPrimary})`}>
              <path
                fill="#fff"
                d="M678.927-4.5c0-105.127 85.123-190.376 190.122-190.376 104.998 0 190.161 85.249 190.161 190.376z"
              />
            </g>
          </g>
          <g opacity=".3">
            <g filter={`url(#${ids.filters.moonSecondary})`}>
              <path
                fill="#fff"
                d="M1058.93-4.92c0 105.127-85.124 190.375-190.122 190.375S678.646 100.207 678.646-4.92z"
              />
            </g>
            <path
              fill={`url(#${ids.gradients.moonInverse})`}
              d="M1203.18-4.5c0 184.745-149.57 334.5-334.091 334.5C684.571 330 535 180.244 535-4.5 535-189.245 684.571-339 869.089-339c184.521 0 334.091 149.776 334.091 334.5"
              style={{ mixBlendMode: "screen" }}
            />
          </g>
          <g opacity=".8">
            <path
              fill="#fff"
              d="M1000.66 127.955c73.1-73.1 73.1-191.62 0-264.719-73.099-73.1-191.618-73.1-264.718 0s-73.1 191.619 0 264.719 191.619 73.1 264.718 0"
            />
            <path
              fill="#ebebeb"
              d="M900.345 123.795c14.643-12.265 16.57-34.079 4.305-48.722s-34.078-16.57-48.721-4.305-16.571 34.079-4.306 48.722 34.079 16.57 48.722 4.305"
            />
            <path
              fill="#dfdfdf"
              d="M846.205 100.484c0-19.11 15.497-34.586 34.585-34.586 10.034 0 19.024 4.288 25.336 11.1-6.291-8.662-16.455-14.321-27.991-14.321-19.11 0-34.586 15.497-34.586 34.586 0 9.076 3.526 17.325 9.251 23.485-4.136-5.703-6.595-12.69-6.595-20.264"
            />
            <path
              fill="#ebebeb"
              d="M806.365-34.723c1.673-26.297-18.289-48.97-44.585-50.643-26.297-1.673-48.97 18.288-50.643 44.585-1.673 26.296 18.288 48.97 44.585 50.643 26.296 1.673 48.97-18.289 50.643-44.585M699.243 7.392c-6.508 0-11.797-5.289-11.797-11.797s5.289-11.797 11.797-11.797 11.797 5.29 11.797 11.797-5.289 11.797-11.797 11.797"
            />
            <path
              fill="#dfdfdf"
              d="M688.36-3.295c0-6.508 5.289-11.797 11.797-11.797 3.417 0 6.486 1.459 8.641 3.787a11.73 11.73 0 0 0-9.533-4.875c-6.508 0-11.797 5.289-11.797 11.797a11.73 11.73 0 0 0 3.156 8.01 11.67 11.67 0 0 1-2.242-6.9z"
            />
            <path
              fill="#ebebeb"
              d="M723.49 19.19a5.89 5.89 0 0 1-5.898-5.9 5.89 5.89 0 0 1 5.898-5.898 5.89 5.89 0 0 1 5.899 5.899 5.89 5.89 0 0 1-5.899 5.898"
            />
            <path
              fill="#dfdfdf"
              d="M718.049 13.835a5.883 5.883 0 0 1 10.208-4.005 5.87 5.87 0 0 0-4.767-2.438 5.89 5.89 0 0 0-5.898 5.899c0 1.545.609 2.96 1.567 4.005-.697-.98-1.132-2.155-1.132-3.461z"
            />
            <path
              fill="#ebebeb"
              d="M924.605 93.04a5.89 5.89 0 0 1-5.898-5.899 5.89 5.89 0 0 1 5.898-5.898 5.89 5.89 0 0 1 5.899 5.898 5.89 5.89 0 0 1-5.899 5.899"
            />
            <path
              fill="#dfdfdf"
              d="M919.164 87.686a5.883 5.883 0 0 1 10.208-4.005 5.87 5.87 0 0 0-4.767-2.438 5.89 5.89 0 0 0-5.898 5.898c0 1.546.609 2.96 1.567 4.005-.697-.979-1.132-2.154-1.132-3.46z"
            />
            <path
              fill="#ebebeb"
              d="M945.478 147.955c-6.508 0-11.797-5.289-11.797-11.797s5.289-11.797 11.797-11.797 11.797 5.289 11.797 11.797-5.289 11.797-11.797 11.797"
            />
            <path
              fill="#dfdfdf"
              d="M934.596 137.246c0-6.508 5.289-11.797 11.797-11.797 3.417 0 6.486 1.458 8.64 3.787a11.73 11.73 0 0 0-9.533-4.875c-6.508 0-11.797 5.289-11.797 11.797 0 3.09 1.197 5.898 3.156 8.01a11.68 11.68 0 0 1-2.242-6.9z"
            />
            <path
              fill="#ebebeb"
              d="M926.433 73.625c10.518 0 19.045-8.527 19.045-19.045s-8.527-19.045-19.045-19.045-19.045 8.527-19.045 19.045 8.527 19.045 19.045 19.045"
            />
            <path
              fill="#dfdfdf"
              d="M908.846 56.365c0-10.513 8.533-19.045 19.045-19.045 5.529 0 10.47 2.35 13.952 6.116-3.461-4.767-9.054-7.88-15.41-7.88-10.513 0-19.045 8.533-19.045 19.046 0 5.006 1.937 9.533 5.093 12.929a18.88 18.88 0 0 1-3.635-11.166"
            />
            <path
              fill="#ebebeb"
              d="M808.986 124.361c10.518 0 19.045-8.527 19.045-19.045s-8.527-19.045-19.045-19.045-19.045 8.527-19.045 19.045 8.527 19.045 19.045 19.045"
            />
            <path
              fill="#dfdfdf"
              d="M791.399 107.1c0-10.512 8.532-19.044 19.045-19.044 5.529 0 10.469 2.35 13.952 6.116-3.461-4.767-9.055-7.88-15.41-7.88-10.513 0-19.045 8.533-19.045 19.045 0 5.007 1.937 9.534 5.093 12.929a18.88 18.88 0 0 1-3.635-11.166"
            />
            <path
              fill="#b8b8b8"
              d="M826.986 110.67c-48.885-.217-94.114-15.823-131.116-42.182 28.295 66.865 94.376 113.944 171.579 114.292 103.387.479 187.581-82.949 188.031-186.336.09-18.522-2.57-36.414-7.49-53.326-26.64 96.966-115.636 168.009-221.004 167.531z"
              opacity=".2"
            />
            <path
              fill="#b8b8b8"
              d="M842.505 144.342c-46.295-.218-89.304-14.213-125.152-38.09 33.889 46.165 88.433 76.245 150.095 76.506 101.82.457 184.962-80.467 187.902-181.678-33.8 84.32-116.488 143.675-212.845 143.24z"
              opacity=".2"
            />
          </g>
        </g>
        <path
          fill={`url(#${ids.gradients.cloud1})`}
          d="M292.63 257.159c.01-.151.02-.292.02-.442 0-3.488-2.81-6.312-6.28-6.312-1.83 0-3.48.794-4.63 2.05a7.87 7.87 0 0 0-6.96-4.211c-.34 0-.67.03-1 .07a7.76 7.76 0 0 0-6.87-4.161c-1.22 0-2.36.292-3.39.784-.71-5.267-5.19-9.337-10.63-9.337-2.06 0-3.97.593-5.6 1.598-1.52-2.442-4.21-4.061-7.28-4.061-2.53 0-4.8 1.106-6.37 2.855a10.88 10.88 0 0 0-7.35-2.855c-.93 0-1.82.131-2.68.342-1.02-2.804-3.69-4.814-6.84-4.814-.13 0-.26.01-.38.02v-.02c0-3.83-3.09-6.935-6.9-6.935-.87 0-1.71.171-2.48.462.11-.603.17-1.216.17-1.859 0-5.709-4.6-10.333-10.28-10.333s-10.28 4.624-10.28 10.333c0 1.105.18 2.161.49 3.156a9.14 9.14 0 0 0-5.4-1.769c-5.08 0-9.2 4.141-9.2 9.246 0 1.066.19 2.091.52 3.046a7.2 7.2 0 0 0-3.47-.885c-4 0-7.24 3.257-7.24 7.277 0 1.327.36 2.563.98 3.639-1.82-2.322-4.65-3.83-7.82-3.83s-6.26 1.639-8.07 4.151a6.52 6.52 0 0 0-3.58-1.065c-2.79 0-5.17 1.749-6.14 4.211a5.62 5.62 0 0 0-3.37-1.126c-3.13 0-5.67 2.553-5.67 5.699q0 .272.03.543a5.3 5.3 0 0 0-2.33-.543c-2.85 0-5.18 2.242-5.35 5.066h171.6z"
          style={{
            mixBlendMode: "screen",
            opacity: "var(--hero-cloud-opacity-1)",
            transition: "opacity 0.5s ease-in-out",
          }}
        />
        <path
          fill={`url(#${ids.gradients.cloud2})`}
          d="M1793.55 549.65c-.21-11.98-9.97-21.63-22.01-21.63-.1 0-.2.01-.3.02-1.85-13.17-13.13-23.31-26.81-23.31s-24.81 10.01-26.77 23.06c-4.23-2.54-9.19-4-14.48-4s-9.75 1.32-13.84 3.63c-.32-9.31-7.95-16.76-17.34-16.76-.2 0-.39.02-.58.03 0-.27.02-.53.02-.8 0-15.4-12.49-27.89-27.89-27.89-11.29 0-21 6.71-25.39 16.35a17.32 17.32 0 0 0-12.24-5.05c-6.34 0-11.87 3.41-14.9 8.49-5.48-5.25-12.91-8.49-21.1-8.49-15.79 0-28.77 12-30.34 27.37-1.68-.43-3.43-.68-5.24-.68-10.97 0-19.99 8.34-21.07 19.03-6.08 1.99-10.27 6.18-10.27 11.04 0 6.78 8.15 12.28 18.21 12.28.48 0 .96-.02 1.43-.05 3.04 2.91 7.16 4.71 11.7 4.71.64 0 1.26-.04 1.88-.11 2.92 5.84 8.93 9.86 15.91 9.86 3.95 0 7.58-1.3 10.53-3.47 4.49 3.24 9.99 5.16 15.94 5.16 10.02 0 18.75-5.41 23.51-13.45 3.33 4.31 8.54 7.09 14.4 7.09 4.56 0 8.72-1.69 11.91-4.45 1.95 4.32 6.29 7.33 11.34 7.33 2.4 0 4.63-.69 6.53-1.86 4.53 3.34 10.11 5.34 16.17 5.34 7.55 0 14.39-3.07 19.34-8.02 5.17 6 12.82 9.8 21.37 9.8 7.75 0 14.77-3.13 19.87-8.19 3.49 4.45 8.91 7.31 15 7.31s11.47-2.85 14.97-7.27c3.02 3.87 7.72 6.37 13.01 6.37 4.36 0 8.31-1.7 11.27-4.46 2.47 1.89 5.55 3.03 8.9 3.03 8.1 0 14.67-6.57 14.67-14.67 0-5.42-2.95-10.14-7.32-12.68z"
          style={{
            mixBlendMode: "screen",
            opacity: "var(--hero-cloud-opacity-2)",
            transition: "opacity 0.5s ease-in-out",
          }}
        />
        <path
          fill={`url(#${ids.gradients.cloud3})`}
          d="M383.868 665.183c-.274-15.079-12.486-27.227-27.561-27.227-.128 0-.237 0-.365.018-2.315-16.582-16.441-29.335-33.576-29.335-17.134 0-31.078 12.606-33.521 29.023a35.1 35.1 0 0 0-18.137-5.038c-6.635 0-12.213 1.667-17.335 4.562-.401-11.727-9.952-21.108-21.709-21.108-.237 0-.492.037-.729.037 0-.33.018-.678.018-1.008 0-19.386-15.64-35.107-34.925-35.107-14.127 0-26.303 8.447-31.79 20.577-3.937-3.94-9.351-6.358-15.329-6.358-7.948 0-14.874 4.287-18.666 10.682-6.872-6.615-16.168-10.682-26.431-10.682-19.777 0-36.036 15.098-37.987 34.447-2.096-.532-4.302-.861-6.562-.861-13.744 0-25.045 10.499-26.394 23.948C25.268 654.263 20 659.54 20 665.66c0 8.538 10.208 15.464 22.803 15.464.602 0 1.203-.036 1.787-.055 3.81 3.665 8.968 5.919 14.655 5.919.802 0 1.586-.055 2.351-.147 3.664 7.348 11.192 12.405 19.924 12.405 4.94 0 9.496-1.631 13.178-4.379 5.615 4.067 12.505 6.504 19.96 6.504 12.541 0 23.478-6.816 29.438-16.93 4.175 5.423 10.682 8.923 18.028 8.923 5.705 0 10.918-2.125 14.91-5.607 2.443 5.442 7.875 9.235 14.2 9.235 3.008 0 5.797-.861 8.184-2.345 5.669 4.196 12.669 6.724 20.252 6.724 9.46 0 18.027-3.866 24.225-10.096 6.471 7.549 16.059 12.35 26.759 12.35 9.715 0 18.501-3.939 24.881-10.316 4.374 5.607 11.155 9.217 18.793 9.217 7.637 0 14.364-3.592 18.738-9.144 3.792 4.874 9.679 8.008 16.296 8.008 5.469 0 10.408-2.144 14.109-5.607 3.098 2.382 6.944 3.811 11.155 3.811 10.135 0 18.374-8.264 18.374-18.47 0-6.816-3.7-12.771-9.169-15.959z"
          style={{
            mixBlendMode: "screen",
            opacity: "var(--hero-cloud-opacity-3)",
            transition: "opacity 0.5s ease-in-out",
          }}
        />
        <path
          fill={`url(#${ids.gradients.rightMountain})`}
          d="M1579.74 920.763c-63.43 16.956-129.83 18.198-195.17 24.571-58.11 5.659-117.44 16.104-168.47 43.642H1728V871.783c-50.23 12.401-98.01 35.545-148.26 48.98"
        />
        <path
          fill={`url(#${ids.gradients.leftMountain})`}
          d="M148.262 920.763c63.43 16.956 129.831 18.198 195.172 24.571 58.107 5.659 117.435 16.104 168.469 43.642H0V871.783c50.227 12.401 98.012 35.545 148.262 48.98"
        />
        <g
          style={{
            opacity: "var(--hero-sun-opacity)",
            transform: `translateY(var(--hero-sun-y))`,
            transformOrigin: "50% 50%",
            transformBox: "fill-box",
            transition: "opacity 0.5s ease-in-out, transform 0.5s ease-in-out",
          }}
        >
          <path
            fill={`url(#${ids.gradients.sun})`}
            d="M457 988.512C457 763.443 639.219 581 864.012 581c224.798 0 407.008 182.443 407.008 407.512s-182.21 407.508-407.008 407.508C639.219 1396.02 457 1213.56 457 988.512"
            style={{ mixBlendMode: "screen" }}
          />
          <g filter={`url(#${ids.filters.sun})`}>
            <path
              fill="#fff"
              d="M632.343 988.512c0-128.074 103.704-231.929 231.62-231.929s231.667 103.855 231.667 231.929z"
            />
          </g>
        </g>
      </g>
      <defs>
        <filter
          id={ids.filters.sun}
          x="612.343"
          y="736.583"
          width="503.29"
          height="271.929"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset />
          <feGaussianBlur stdDeviation="10" />
          <feColorMatrix type="matrix" values="0 0 0 0 0.976471 0 0 0 0 0.976471 0 0 0 0 0.976471 0 0 0 0.75 0" />
          <feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow_23040_8793" />
          <feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow_23040_8793" result="shape" />
        </filter>
        <filter
          id={ids.filters.moonPrimary}
          x="658.927"
          y="-214.876"
          width="420.284"
          height="230.376"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset />
          <feGaussianBlur stdDeviation="10" />
          <feColorMatrix type="matrix" values="0 0 0 0 0.976471 0 0 0 0 0.976471 0 0 0 0 0.976471 0 0 0 0.75 0" />
          <feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow_23089_33678" />
          <feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow_23089_33678" result="shape" />
        </filter>
        <filter
          id={ids.filters.moonSecondary}
          x="658.646"
          y="-24.9205"
          width="420.284"
          height="230.376"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset />
          <feGaussianBlur stdDeviation="10" />
          <feColorMatrix type="matrix" values="0 0 0 0 0.976471 0 0 0 0 0.976471 0 0 0 0 0.976471 0 0 0 0.75 0" />
          <feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow_23089_33678" />
          <feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow_23089_33678" result="shape" />
        </filter>
        <linearGradient
          id={ids.gradients.background}
          x1="630"
          y1="58.295"
          x2="634.041"
          y2="1218.16"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset=".029" stopColor={getGradientColor(1)} style={{ transition: "stop-color 0.5s ease-in-out" }} />
          <stop offset=".308" stopColor={getGradientColor(2)} style={{ transition: "stop-color 0.5s ease-in-out" }} />
          <stop offset="1" stopColor={getGradientColor(3)} style={{ transition: "stop-color 0.5s ease-in-out" }} />
        </linearGradient>
        <linearGradient
          id={ids.gradients.cloud1}
          x1="161.07"
          y1="234.012"
          x2="254.319"
          y2="265.884"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#ff719f" />
          <stop offset="1" stopColor="#975fff" />
        </linearGradient>
        <linearGradient
          id={ids.gradients.cloud2}
          x1="1696.63"
          y1="486.59"
          x2="1631.75"
          y2="588.89"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#ff719f" />
          <stop offset="1" stopColor="#975fff" />
        </linearGradient>
        <linearGradient
          id={ids.gradients.cloud3}
          x1="324.499"
          y1="616.115"
          x2="70.055"
          y2="705.325"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#ff719f" />
          <stop offset="1" stopColor="#975fff" />
        </linearGradient>
        <linearGradient
          id={ids.gradients.rightMountain}
          x1="1472.05"
          y1="875.119"
          x2="1472.05"
          y2="982.742"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#9b4fd8" />
          <stop offset="1" stopColor="#65448c" />
        </linearGradient>
        <linearGradient
          id={ids.gradients.leftMountain}
          x1="255.951"
          y1="852.435"
          x2="255.951"
          y2="978.647"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#9b4fd8" />
          <stop offset="1" stopColor="#65448c" />
        </linearGradient>
        <radialGradient
          id={ids.gradients.sun}
          cx="0"
          cy="0"
          r="1"
          gradientUnits="userSpaceOnUse"
          gradientTransform="matrix(407.012 0 0 407.512 864.012 988.512)"
        >
          <stop stopColor="#feffff" />
          <stop offset=".1" stopColor="#feffff" stopOpacity=".98" />
          <stop offset=".23" stopColor="#feffff" stopOpacity=".92" />
          <stop offset=".36" stopColor="#feffff" stopOpacity=".83" />
          <stop offset=".5" stopColor="#feffff" stopOpacity=".7" />
          <stop offset=".65" stopColor="#feffff" stopOpacity=".53" />
          <stop offset=".8" stopColor="#feffff" stopOpacity=".33" />
          <stop offset=".95" stopColor="#feffff" stopOpacity=".09" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <radialGradient
          id={ids.gradients.moon}
          cx="0"
          cy="0"
          r="1"
          gradientUnits="userSpaceOnUse"
          gradientTransform="matrix(334.09 0 0 334.5 869.09 -4.5)"
        >
          <stop stopColor="#feffff" />
          <stop offset=".1" stopColor="#feffff" stopOpacity=".98" />
          <stop offset=".23" stopColor="#feffff" stopOpacity=".92" />
          <stop offset=".36" stopColor="#feffff" stopOpacity=".83" />
          <stop offset=".5" stopColor="#feffff" stopOpacity=".7" />
          <stop offset=".65" stopColor="#feffff" stopOpacity=".53" />
          <stop offset=".8" stopColor="#feffff" stopOpacity=".33" />
          <stop offset=".95" stopColor="#feffff" stopOpacity=".09" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <radialGradient
          id={ids.gradients.moonInverse}
          cx="0"
          cy="0"
          r="1"
          gradientUnits="userSpaceOnUse"
          gradientTransform="matrix(-334.09 0 0 -334.5 869.089 -4.5)"
        >
          <stop stopColor="#feffff" />
          <stop offset=".1" stopColor="#feffff" stopOpacity=".98" />
          <stop offset=".23" stopColor="#feffff" stopOpacity=".92" />
          <stop offset=".36" stopColor="#feffff" stopOpacity=".83" />
          <stop offset=".5" stopColor="#feffff" stopOpacity=".7" />
          <stop offset=".65" stopColor="#feffff" stopOpacity=".53" />
          <stop offset=".8" stopColor="#feffff" stopOpacity=".33" />
          <stop offset=".95" stopColor="#feffff" stopOpacity=".09" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
      </defs>
    </svg>
  );
}
