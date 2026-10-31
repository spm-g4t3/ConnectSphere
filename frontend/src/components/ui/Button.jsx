import "./ui.css";

export default function Button({
  variant = "primary",
  type = "button",
  className,
  ...props
}) {
  const classes = ["ui-button", `ui-button--${variant}`, className]
    .filter(Boolean)
    .join(" ");
  return <button type={type} className={classes} {...props} />;
}
