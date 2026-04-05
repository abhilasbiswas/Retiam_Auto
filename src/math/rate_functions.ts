export const rate_functions = {
                linear: t => t, smooth: t => t * t * (3 - 2 * t), easeIn: t => t * t, easeOut: t => t * (2 - t),
                easeOutBounce: t => {
                    const n1 = 7.5625, d1 = 2.75;
                    if (t < 1 / d1) return n1 * t * t;
                    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
                    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
                    return n1 * (t -= 2.625 / d1) * t + 0.984375;
                },
                easeOutElastic: t => t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1
            };