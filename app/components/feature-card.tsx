import { cn } from "~/lib/utils";
import { Card, CardDescription, CardHeader, CardTitle } from "./ui/card";

interface FeatureCardProps {
  title: string;
  description: string;
  imageSrc: string;
  imageAlt: string;
  imageWidth: number;
  imageHeight: number;
  className?: string;
}

export function FeatureCard({
  title,
  description,
  imageSrc,
  imageAlt,
  imageWidth,
  imageHeight,
  className,
}: FeatureCardProps) {
  return (
    <Card className={cn("mt-20 shadow-2xl", className)}>
      <div className="overflow-hidden -mt-20">
        <img
          src={imageSrc}
          alt={imageAlt}
          width={imageWidth}
          height={imageHeight}
          className="w-3/5 mx-auto h-auto object-cover"
        />
      </div>
      <CardHeader>
        <CardTitle className="font-grotesc font-bold text-purple-500 text-3xl md:text-4xl leading-none">
          {title}
        </CardTitle>
        <CardDescription className="text-violet-500 text-2xl md:text-3xl leading-none">{description}</CardDescription>
      </CardHeader>
    </Card>
  );
}
