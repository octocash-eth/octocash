import { Card, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { cn } from "~/lib/utils";

interface FeatureCardProps {
  title: string;
  description: string;
  imageSrc: string;
  imageSrcDark?: string;
  imageAlt: string;
  imageWidth: number;
  imageHeight: number;
  className?: string;
}

export function FeatureCard({
  title,
  description,
  imageSrc,
  imageSrcDark,
  imageAlt,
  imageWidth,
  imageHeight,
  className,
}: FeatureCardProps) {
  const hasThemeVariants = !!imageSrcDark;

  return (
    <Card className={cn("mt-20 shadow-2xl", className)}>
      <div className="overflow-hidden -mt-20">
        {hasThemeVariants ? (
          <>
            <img
              src={imageSrc}
              alt={imageAlt}
              width={imageWidth}
              height={imageHeight}
              className="w-3/5 mx-auto h-auto object-cover dark:hidden"
              loading="lazy"
              decoding="async"
            />
            <img
              src={imageSrcDark}
              alt={imageAlt}
              width={imageWidth}
              height={imageHeight}
              className="w-3/5 mx-auto h-auto object-cover hidden dark:block"
              loading="lazy"
              decoding="async"
            />
          </>
        ) : (
          <img
            src={imageSrc}
            alt={imageAlt}
            width={imageWidth}
            height={imageHeight}
            className="w-3/5 mx-auto h-auto object-cover"
            loading="lazy"
            decoding="async"
          />
        )}
      </div>
      <CardHeader>
        <CardTitle className="font-grotesque font-bold text-secondary text-3xl md:text-4xl leading-none">
          {title}
        </CardTitle>
        <CardDescription className="text-card-foreground text-2xl md:text-3xl leading-none">
          {description}
        </CardDescription>
      </CardHeader>
    </Card>
  );
}
