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
      width="1728"
      height="989"
      viewBox="0 0 1728 989"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      preserveAspectRatio="xMidYMid slice"
      role="img"
      aria-label="Hero background illustration with day and night theme"
      style={{
        // CSS transitions for smooth theme changes
        transition: "opacity 0.5s ease-in-out",
      }}
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
        <rect width="1728" height="989" fill="#D9D9D9" />
      </mask>
      <g mask={`url(#${ids.mask})`}>
        <path d="M1728 0H0V989H1728V0Z" fill={`url(#${ids.gradients.background})`} />
        <g
          style={{
            opacity: "var(--hero-moon-opacity)",
            transform: `translateY(var(--hero-moon-y))`,
            transformOrigin: "50% 50%",
            transformBox: "fill-box",
            transition: "opacity 0.5s ease-in-out, transform 0.5s ease-in-out",
          }}
        >
          <g opacity="0.3">
            <path
              style={{ mixBlendMode: "screen" }}
              d="M535 -4.5C535 -189.245 684.572 -339 869.09 -339C1053.61 -339 1203.18 -189.245 1203.18 -4.5C1203.18 180.245 1053.61 330 869.09 330C684.572 330 535 180.224 535 -4.5Z"
              fill={`url(#${ids.gradients.moon})`}
            />
            <g filter={`url(#${ids.filters.moonPrimary})`}>
              <path
                d="M678.927 -4.50005C678.927 -109.627 764.05 -194.876 869.049 -194.876C974.047 -194.876 1059.21 -109.627 1059.21 -4.50005H678.927Z"
                fill="white"
              />
            </g>
          </g>
          <g opacity="0.3">
            <g filter={`url(#${ids.filters.moonSecondary})`}>
              <path
                d="M1058.93 -4.92046C1058.93 100.207 973.806 185.455 868.808 185.455C763.809 185.455 678.646 100.207 678.646 -4.92049L1058.93 -4.92046Z"
                fill="white"
              />
            </g>
            <path
              style={{ mixBlendMode: "screen" }}
              d="M1203.18 -4.5C1203.18 180.245 1053.61 330 869.089 330C684.571 330 535 180.244 535 -4.50006C535 -189.245 684.571 -339 869.089 -339C1053.61 -339 1203.18 -189.224 1203.18 -4.5Z"
              fill={`url(#${ids.gradients.moonInverse})`}
            />
          </g>
          <g opacity="0.8">
            <path
              d="M1000.66 127.955C1073.76 54.8547 1073.76 -63.6641 1000.66 -136.764C927.561 -209.864 809.042 -209.864 735.942 -136.764C662.842 -63.6641 662.842 54.8547 735.942 127.955C809.042 201.055 927.561 201.055 1000.66 127.955Z"
              fill="white"
            />
            <path
              d="M900.345 123.795C914.988 111.53 916.915 89.7164 904.65 75.0734C892.385 60.4304 870.572 58.5028 855.929 70.768C841.286 83.0332 839.358 104.847 851.623 119.49C863.888 134.133 885.702 136.06 900.345 123.795Z"
              fill="#EBEBEB"
            />
            <path
              d="M846.205 100.484C846.205 81.3737 861.702 65.8983 880.79 65.8983C890.824 65.8983 899.814 70.1862 906.126 76.9988C899.835 68.3361 889.671 62.677 878.135 62.677C859.025 62.677 843.549 78.1741 843.549 97.2626C843.549 106.339 847.075 114.588 852.8 120.748C848.664 115.045 846.205 108.058 846.205 100.484Z"
              fill="#DFDFDF"
            />
            <path
              d="M806.365 -34.7231C808.038 -61.0196 788.076 -83.6933 761.78 -85.3662C735.483 -87.0391 712.81 -67.0776 711.137 -40.7811C709.464 -14.4846 729.425 8.18907 755.722 9.86194C782.018 11.5348 804.692 -8.4266 806.365 -34.7231Z"
              fill="#EBEBEB"
            />
            <path
              d="M699.243 7.39218C692.735 7.39218 687.446 2.10313 687.446 -4.4048C687.446 -10.9127 692.735 -16.2018 699.243 -16.2018C705.751 -16.2018 711.04 -10.9127 711.04 -4.4048C711.04 2.10313 705.751 7.39218 699.243 7.39218Z"
              fill="#EBEBEB"
            />
            <path
              d="M688.36 -3.29479C688.36 -9.80272 693.649 -15.0918 700.157 -15.0918C703.574 -15.0918 706.643 -13.6335 708.798 -11.3046C706.665 -14.2647 703.183 -16.1801 699.265 -16.1801C692.757 -16.1801 687.468 -10.891 687.468 -4.38307C687.468 -1.29235 688.665 1.51542 690.624 3.62669C689.209 1.68954 688.382 -0.704673 688.382 -3.27302L688.36 -3.29479Z"
              fill="#DFDFDF"
            />
            <path
              d="M723.49 19.1891C720.225 19.1891 717.592 16.5554 717.592 13.2906C717.592 10.0257 720.225 7.39209 723.49 7.39209C726.755 7.39209 729.389 10.0257 729.389 13.2906C729.389 16.5554 726.755 19.1891 723.49 19.1891Z"
              fill="#EBEBEB"
            />
            <path
              d="M718.049 13.8347C718.049 10.5699 720.683 7.93623 723.947 7.93623C725.645 7.93623 727.19 8.67627 728.257 9.82985C727.19 8.34978 725.449 7.39209 723.49 7.39209C720.225 7.39209 717.592 10.0257 717.592 13.2906C717.592 14.836 718.201 16.2507 719.159 17.2955C718.462 16.316 718.027 15.1407 718.027 13.8347H718.049Z"
              fill="#DFDFDF"
            />
            <path
              d="M924.605 93.04C921.34 93.04 918.707 90.4064 918.707 87.1415C918.707 83.8767 921.34 81.243 924.605 81.243C927.87 81.243 930.504 83.8767 930.504 87.1415C930.504 90.4064 927.87 93.04 924.605 93.04Z"
              fill="#EBEBEB"
            />
            <path
              d="M919.164 87.6857C919.164 84.4208 921.797 81.7872 925.062 81.7872C926.76 81.7872 928.305 82.5272 929.372 83.6808C928.305 82.2008 926.564 81.243 924.605 81.243C921.34 81.243 918.707 83.8767 918.707 87.1415C918.707 88.6869 919.316 90.1017 920.274 91.1464C919.577 90.167 919.142 88.9916 919.142 87.6857H919.164Z"
              fill="#DFDFDF"
            />
            <path
              d="M945.478 147.955C938.97 147.955 933.681 142.666 933.681 136.158C933.681 129.65 938.97 124.361 945.478 124.361C951.986 124.361 957.275 129.65 957.275 136.158C957.275 142.666 951.986 147.955 945.478 147.955Z"
              fill="#EBEBEB"
            />
            <path
              d="M934.596 137.246C934.596 130.738 939.885 125.449 946.393 125.449C949.81 125.449 952.879 126.907 955.033 129.236C952.9 126.276 949.418 124.361 945.5 124.361C938.992 124.361 933.703 129.65 933.703 136.158C933.703 139.248 934.9 142.056 936.859 144.168C935.444 142.23 934.617 139.836 934.617 137.268L934.596 137.246Z"
              fill="#DFDFDF"
            />
            <path
              d="M926.433 73.6251C936.951 73.6251 945.478 65.0983 945.478 54.5801C945.478 44.0619 936.951 35.5352 926.433 35.5352C915.915 35.5352 907.388 44.0619 907.388 54.5801C907.388 65.0983 915.915 73.6251 926.433 73.6251Z"
              fill="#EBEBEB"
            />
            <path
              d="M908.846 56.3647C908.846 45.8519 917.379 37.3198 927.891 37.3198C933.42 37.3198 938.361 39.6705 941.843 43.4359C938.382 38.6692 932.789 35.5568 926.433 35.5568C915.92 35.5568 907.388 44.0889 907.388 54.6017C907.388 59.6078 909.325 64.135 912.481 67.5305C910.196 64.3962 908.846 60.5437 908.846 56.3647Z"
              fill="#DFDFDF"
            />
            <path
              d="M808.986 124.361C819.504 124.361 828.031 115.834 828.031 105.316C828.031 94.7976 819.504 86.2709 808.986 86.2709C798.468 86.2709 789.941 94.7976 789.941 105.316C789.941 115.834 798.468 124.361 808.986 124.361Z"
              fill="#EBEBEB"
            />
            <path
              d="M791.399 107.1C791.399 96.5876 799.931 88.0555 810.444 88.0555C815.973 88.0555 820.913 90.4062 824.396 94.1716C820.935 89.405 815.341 86.2925 808.986 86.2925C798.473 86.2925 789.941 94.8246 789.941 105.337C789.941 110.344 791.878 114.871 795.034 118.266C792.749 115.132 791.399 111.279 791.399 107.1Z"
              fill="#DFDFDF"
            />
            <path
              opacity="0.2"
              d="M826.986 110.67C778.101 110.453 732.872 94.8466 695.87 68.4884C724.165 135.353 790.246 182.432 867.449 182.78C970.836 183.259 1055.03 99.831 1055.48 -3.55586C1055.57 -22.0784 1052.91 -39.9698 1047.99 -56.8817C1021.35 40.0843 932.354 111.127 826.986 110.649V110.67Z"
              fill="#B8B8B8"
            />
            <path
              opacity="0.2"
              d="M842.505 144.342C796.21 144.124 753.201 130.129 717.353 106.252C751.242 152.417 805.786 182.497 867.448 182.758C969.268 183.215 1052.41 102.291 1055.35 1.0802C1021.55 85.4004 938.862 144.755 842.505 144.32V144.342Z"
              fill="#B8B8B8"
            />
          </g>
        </g>
        <path
          style={{
            mixBlendMode: "screen",
            opacity: "var(--hero-cloud-opacity-1)",
            transition: "opacity 0.5s ease-in-out",
          }}
          d="M292.63 257.159C292.64 257.008 292.65 256.867 292.65 256.717C292.65 253.229 289.84 250.405 286.37 250.405C284.54 250.405 282.89 251.199 281.74 252.455C280.42 249.952 277.8 248.244 274.78 248.244C274.44 248.244 274.11 248.274 273.78 248.314C272.48 245.842 269.89 244.153 266.91 244.153C265.69 244.153 264.55 244.445 263.52 244.937C262.81 239.67 258.33 235.6 252.89 235.6C250.83 235.6 248.92 236.193 247.29 237.198C245.77 234.756 243.08 233.137 240.01 233.137C237.48 233.137 235.21 234.243 233.64 235.992C231.7 234.223 229.12 233.137 226.29 233.137C225.36 233.137 224.47 233.268 223.61 233.479C222.59 230.675 219.92 228.665 216.77 228.665C216.64 228.665 216.51 228.675 216.39 228.685C216.39 228.685 216.39 228.675 216.39 228.665C216.39 224.835 213.3 221.73 209.49 221.73C208.62 221.73 207.78 221.901 207.01 222.192C207.12 221.589 207.18 220.976 207.18 220.333C207.18 214.624 202.58 210 196.9 210C191.22 210 186.62 214.624 186.62 220.333C186.62 221.438 186.8 222.494 187.11 223.489C185.59 222.383 183.73 221.72 181.71 221.72C176.63 221.72 172.51 225.861 172.51 230.966C172.51 232.032 172.7 233.057 173.03 234.012C172 233.449 170.82 233.127 169.56 233.127C165.56 233.127 162.32 236.384 162.32 240.404C162.32 241.731 162.68 242.967 163.3 244.043C161.48 241.721 158.65 240.213 155.48 240.213C152.31 240.213 149.22 241.852 147.41 244.364C146.38 243.691 145.15 243.299 143.83 243.299C141.04 243.299 138.66 245.048 137.69 247.51C136.75 246.807 135.58 246.384 134.32 246.384C131.19 246.384 128.65 248.937 128.65 252.083C128.65 252.264 128.66 252.445 128.68 252.626C127.98 252.284 127.19 252.083 126.35 252.083C123.5 252.083 121.17 254.325 121 257.149H292.6L292.63 257.159Z"
          fill={`url(#${ids.gradients.cloud1})`}
        />
        <path
          style={{
            mixBlendMode: "screen",
            opacity: "var(--hero-cloud-opacity-2)",
            transition: "opacity 0.5s ease-in-out",
          }}
          d="M1793.55 549.65C1793.34 537.67 1783.58 528.02 1771.54 528.02C1771.44 528.02 1771.34 528.03 1771.24 528.04C1769.39 514.87 1758.11 504.73 1744.43 504.73C1730.75 504.73 1719.62 514.74 1717.66 527.79C1713.43 525.25 1708.47 523.79 1703.18 523.79C1697.89 523.79 1693.43 525.11 1689.34 527.42C1689.02 518.11 1681.39 510.66 1672 510.66C1671.8 510.66 1671.61 510.68 1671.42 510.69C1671.42 510.42 1671.44 510.16 1671.44 509.89C1671.44 494.49 1658.95 482 1643.55 482C1632.26 482 1622.55 488.71 1618.16 498.35C1615.02 495.23 1610.69 493.3 1605.92 493.3C1599.58 493.3 1594.05 496.71 1591.02 501.79C1585.54 496.54 1578.11 493.3 1569.92 493.3C1554.13 493.3 1541.15 505.3 1539.58 520.67C1537.9 520.24 1536.15 519.99 1534.34 519.99C1523.37 519.99 1514.35 528.33 1513.27 539.02C1507.19 541.01 1503 545.2 1503 550.06C1503 556.84 1511.15 562.34 1521.21 562.34C1521.69 562.34 1522.17 562.32 1522.64 562.29C1525.68 565.2 1529.8 567 1534.34 567C1534.98 567 1535.6 566.96 1536.22 566.89C1539.14 572.73 1545.15 576.75 1552.13 576.75C1556.08 576.75 1559.71 575.45 1562.66 573.28C1567.15 576.52 1572.65 578.44 1578.6 578.44C1588.62 578.44 1597.35 573.03 1602.11 564.99C1605.44 569.3 1610.65 572.08 1616.51 572.08C1621.07 572.08 1625.23 570.39 1628.42 567.63C1630.37 571.95 1634.71 574.96 1639.76 574.96C1642.16 574.96 1644.39 574.27 1646.29 573.1C1650.82 576.44 1656.4 578.44 1662.46 578.44C1670.01 578.44 1676.85 575.37 1681.8 570.42C1686.97 576.42 1694.62 580.22 1703.17 580.22C1710.92 580.22 1717.94 577.09 1723.04 572.03C1726.53 576.48 1731.95 579.34 1738.04 579.34C1744.13 579.34 1749.51 576.49 1753.01 572.07C1756.03 575.94 1760.73 578.44 1766.02 578.44C1770.38 578.44 1774.33 576.74 1777.29 573.98C1779.76 575.87 1782.84 577.01 1786.19 577.01C1794.29 577.01 1800.86 570.44 1800.86 562.34C1800.86 556.92 1797.91 552.2 1793.54 549.66L1793.55 549.65Z"
          fill={`url(#${ids.gradients.cloud2})`}
        />
        <path
          style={{
            mixBlendMode: "screen",
            opacity: "var(--hero-cloud-opacity-3)",
            transition: "opacity 0.5s ease-in-out",
          }}
          d="M383.868 665.183C383.594 650.104 371.382 637.956 356.307 637.956C356.179 637.956 356.07 637.956 355.942 637.974C353.627 621.392 339.501 608.639 322.366 608.639C305.232 608.639 291.288 621.245 288.845 637.662C283.541 634.474 277.343 632.624 270.708 632.624C264.073 632.624 258.495 634.291 253.373 637.186C252.972 625.459 243.421 616.078 231.664 616.078C231.427 616.078 231.172 616.115 230.935 616.115C230.935 615.785 230.953 615.437 230.953 615.107C230.953 595.721 215.313 580 196.028 580C181.901 580 169.725 588.447 164.238 600.577C160.301 596.637 154.887 594.219 148.909 594.219C140.961 594.219 134.035 598.506 130.243 604.901C123.371 598.286 114.075 594.219 103.812 594.219C84.035 594.219 67.7756 609.317 65.8252 628.666C63.729 628.134 61.5234 627.805 59.2632 627.805C45.5192 627.805 34.2179 638.304 32.869 651.753C25.2679 654.263 20 659.54 20 665.66C20 674.198 30.2077 681.124 42.8033 681.124C43.4048 681.124 44.0063 681.088 44.5896 681.069C48.3993 684.734 53.5578 686.988 59.2449 686.988C60.047 686.988 60.8308 686.933 61.5963 686.841C65.2602 694.189 72.7883 699.246 81.5196 699.246C86.4594 699.246 91.0164 697.615 94.6984 694.867C100.313 698.934 107.203 701.371 114.658 701.371C127.199 701.371 138.136 694.555 144.096 684.441C148.271 689.864 154.778 693.364 162.124 693.364C167.829 693.364 173.042 691.239 177.034 687.757C179.477 693.199 184.909 696.992 191.234 696.992C194.242 696.992 197.031 696.131 199.418 694.647C205.087 698.843 212.087 701.371 219.67 701.371C229.13 701.371 237.697 697.505 243.895 691.275C250.366 698.824 259.954 703.625 270.654 703.625C280.369 703.625 289.155 699.686 295.535 693.309C299.909 698.916 306.69 702.526 314.328 702.526C321.965 702.526 328.692 698.934 333.066 693.382C336.858 698.256 342.745 701.39 349.362 701.39C354.831 701.39 359.77 699.246 363.471 695.783C366.569 698.165 370.415 699.594 374.626 699.594C384.761 699.594 393 691.33 393 681.124C393 674.308 389.3 668.353 383.831 665.165L383.868 665.183Z"
          fill={`url(#${ids.gradients.cloud3})`}
        />
        <path
          d="M1579.74 920.763C1516.31 937.719 1449.91 938.961 1384.57 945.334C1326.46 950.993 1267.13 961.438 1216.1 988.976H1728V871.783C1677.77 884.184 1629.99 907.328 1579.74 920.763Z"
          fill={`url(#${ids.gradients.rightMountain})`}
        />
        <path
          d="M148.262 920.763C211.692 937.719 278.093 938.961 343.434 945.334C401.541 950.993 460.869 961.438 511.903 988.976H0V871.783C50.2272 884.184 98.0122 907.328 148.262 920.763Z"
          fill={`url(#${ids.gradients.leftMountain})`}
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
            style={{ mixBlendMode: "screen" }}
            d="M457 988.512C457 763.443 639.219 581 864.012 581C1088.81 581 1271.02 763.443 1271.02 988.512C1271.02 1213.58 1088.81 1396.02 864.012 1396.02C639.219 1396.02 457 1213.56 457 988.512Z"
            fill={`url(#${ids.gradients.sun})`}
          />
          <g filter={`url(#${ids.filters.sun})`}>
            <path
              d="M632.343 988.512C632.343 860.438 736.047 756.583 863.963 756.583C991.88 756.583 1095.63 860.438 1095.63 988.512H632.343Z"
              fill="white"
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
          y1="58.2947"
          x2="634.041"
          y2="1218.16"
          gradientUnits="userSpaceOnUse"
        >
          <stop
            offset="0.0288462"
            stopColor={getGradientColor(1)}
            style={{ transition: "stop-color 0.5s ease-in-out" }}
          />
          <stop
            offset="0.307692"
            stopColor={getGradientColor(2)}
            style={{ transition: "stop-color 0.5s ease-in-out" }}
          />
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
          <stop stopColor="#FF719F" />
          <stop offset="1" stopColor="#975FFF" />
        </linearGradient>
        <linearGradient
          id={ids.gradients.cloud2}
          x1="1696.63"
          y1="486.59"
          x2="1631.75"
          y2="588.89"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#FF719F" />
          <stop offset="1" stopColor="#975FFF" />
        </linearGradient>
        <linearGradient
          id={ids.gradients.cloud3}
          x1="324.499"
          y1="616.115"
          x2="70.0552"
          y2="705.325"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#FF719F" />
          <stop offset="1" stopColor="#975FFF" />
        </linearGradient>
        <linearGradient
          id={ids.gradients.rightMountain}
          x1="1472.05"
          y1="875.119"
          x2="1472.05"
          y2="982.742"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#9B4FD8" />
          <stop offset="1" stopColor="#65448C" />
        </linearGradient>
        <linearGradient
          id={ids.gradients.leftMountain}
          x1="255.951"
          y1="852.435"
          x2="255.951"
          y2="978.647"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#9B4FD8" />
          <stop offset="1" stopColor="#65448C" />
        </linearGradient>
        <radialGradient
          id={ids.gradients.sun}
          cx="0"
          cy="0"
          r="1"
          gradientUnits="userSpaceOnUse"
          gradientTransform="translate(864.012 988.512) scale(407.012 407.512)"
        >
          <stop stopColor="#FEFFFF" />
          <stop offset="0.1" stopColor="#FEFFFF" stopOpacity="0.98" />
          <stop offset="0.23" stopColor="#FEFFFF" stopOpacity="0.92" />
          <stop offset="0.36" stopColor="#FEFFFF" stopOpacity="0.83" />
          <stop offset="0.5" stopColor="#FEFFFF" stopOpacity="0.7" />
          <stop offset="0.65" stopColor="#FEFFFF" stopOpacity="0.53" />
          <stop offset="0.8" stopColor="#FEFFFF" stopOpacity="0.33" />
          <stop offset="0.95" stopColor="#FEFFFF" stopOpacity="0.09" />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </radialGradient>
        <radialGradient
          id={ids.gradients.moon}
          cx="0"
          cy="0"
          r="1"
          gradientUnits="userSpaceOnUse"
          gradientTransform="translate(869.09 -4.50003) scale(334.09 334.5)"
        >
          <stop stopColor="#FEFFFF" />
          <stop offset="0.1" stopColor="#FEFFFF" stopOpacity="0.98" />
          <stop offset="0.23" stopColor="#FEFFFF" stopOpacity="0.92" />
          <stop offset="0.36" stopColor="#FEFFFF" stopOpacity="0.83" />
          <stop offset="0.5" stopColor="#FEFFFF" stopOpacity="0.7" />
          <stop offset="0.65" stopColor="#FEFFFF" stopOpacity="0.53" />
          <stop offset="0.8" stopColor="#FEFFFF" stopOpacity="0.33" />
          <stop offset="0.95" stopColor="#FEFFFF" stopOpacity="0.09" />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </radialGradient>
        <radialGradient
          id={ids.gradients.moonInverse}
          cx="0"
          cy="0"
          r="1"
          gradientUnits="userSpaceOnUse"
          gradientTransform="translate(869.089 -4.5) rotate(-180) scale(334.09 334.5)"
        >
          <stop stopColor="#FEFFFF" />
          <stop offset="0.1" stopColor="#FEFFFF" stopOpacity="0.98" />
          <stop offset="0.23" stopColor="#FEFFFF" stopOpacity="0.92" />
          <stop offset="0.36" stopColor="#FEFFFF" stopOpacity="0.83" />
          <stop offset="0.5" stopColor="#FEFFFF" stopOpacity="0.7" />
          <stop offset="0.65" stopColor="#FEFFFF" stopOpacity="0.53" />
          <stop offset="0.8" stopColor="#FEFFFF" stopOpacity="0.33" />
          <stop offset="0.95" stopColor="#FEFFFF" stopOpacity="0.09" />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </radialGradient>
      </defs>
    </svg>
  );
}
